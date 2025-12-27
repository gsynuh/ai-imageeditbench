import { atom, map } from "nanostores";
import type {
  Conversation,
  ConversationStats,
  Message,
  MessageRole,
} from "../types/db";
import type {
  OpenRouterCompletionRequest,
  OpenRouterMessage,
} from "../types/openrouter";
import {
  deleteConversation as deleteConversationDb,
  deleteMessage,
  deleteMessagesAfter,
  getConversation,
  getImage,
  getMessages,
  getStats,
  listConversations,
  saveConversation,
  saveImage,
  saveMessage,
  saveStats,
} from "../lib/idb";
import { createId, debounce } from "../lib/utils";
import type { OpenRouterAttachment } from "../lib/openrouter";
import { requestCompletionFull, streamCompletion } from "../lib/openrouter";
import {
  blobToDataUrl,
  canvasToBlob,
  centerCropSquare,
  loadImageFromFile,
} from "../lib/image";
import { exportConversationZip } from "../lib/export";
import {
  collectImageUrlsFromAttachments,
  resolveAndStoreMessageImages,
} from "../lib/conversation/messageImages";
import { calculateModelCostUsd } from "../lib/cost";
import { $settings, setSelectedModels } from "./settingsStore";
import { $activeConversationId, setActiveConversation } from "./appStore";
import { $models } from "./modelsStore";
import { inferModelModalities } from "../lib/modelMeta";
import { getMatchingDefault } from "./defaultsStore";
import {
  $uiState,
  resetHistoryPagination,
  setHistoryHasMore,
  toggleCollapsedMessage,
} from "./uiStore";
import type { InputState } from "./inputStore";
import type { ImageAsset } from "../types/db";

export interface ActiveConversationState {
  conversation: Conversation | null;
  messagesByModel: Record<string, Message[]>;
  statsByModel: Record<string, ConversationStats>;
  streamingByModel: Record<string, boolean>;
  errorsByModel: Record<string, string | null>;
}

export const $activeConversation = map<ActiveConversationState>({
  conversation: null,
  messagesByModel: {},
  statsByModel: {},
  streamingByModel: {},
  errorsByModel: {},
});

export const $history = atom<Conversation[]>([]);

// Map key format: `${modelId}-${runIndex}` for per-run abort controllers
const streamControllers = new Map<string, AbortController>();
const deletedConversationIds = new Set<string>();

function upsertHistoryConversation(conversation: Conversation) {
  if (!conversation.hasRun) return;
  const list = $history.get();
  if (list.length === 0) {
    $history.set([conversation]);
    return;
  }
  const next = [
    conversation,
    ...list.filter((item) => item.id !== conversation.id),
  ]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, list.length);
  $history.set(next);
}

function createEmptyConversation(modelIds: string[]): Conversation {
  const now = Date.now();
  return {
    id: createId("conversation"),
    createdAt: now,
    updatedAt: now,
    modelIds,
    hasRun: false,
    messageCount: 0,
    totalTokens: 0,
    totalCost: 0,
  };
}

const persistConversationDebounced = debounce((conversation: Conversation) => {
  if (deletedConversationIds.has(conversation.id)) return;
  if (!conversation.hasRun) return;
  void saveConversation(conversation);
  upsertHistoryConversation(conversation);
}, 500);

async function ensureStatsForModel(conversationId: string, modelId: string) {
  const current = $activeConversation.get();
  if (current.statsByModel[modelId]) return;
  const stats: ConversationStats = {
    conversationId,
    modelId,
    inputTokens: 0,
    outputTokens: 0,
    totalCost: 0,
  };
  $activeConversation.set({
    ...current,
    statsByModel: { ...current.statsByModel, [modelId]: stats },
  });
}

async function buildOpenRouterMessages(
  conversationId: string,
  modelId: string,
): Promise<OpenRouterMessage[]> {
  const messages = await getMessages(conversationId, modelId);
  const output: OpenRouterMessage[] = [];

  // Check for matching default and prepend system message if present and set
  const matchingDefault = getMatchingDefault(modelId);
  const hasSystemMessage =
    matchingDefault?.systemMessageSet && matchingDefault?.systemMessage?.trim();
  const systemMessageAdded = new Set<string>();

  for (const message of messages) {
    if (message.status === "streaming") continue;
    if (message.status === "error") continue;
    if (
      message.role === "assistant" &&
      !message.contentText.trim() &&
      message.imageIds.length === 0
    ) {
      continue;
    }

    // Prepend system message from default if present and not already added
    if (hasSystemMessage && !systemMessageAdded.has(modelId)) {
      output.push({ role: "system", content: matchingDefault!.systemMessage! });
      systemMessageAdded.add(modelId);
    }

    if (message.imageIds.length === 0) {
      output.push({ role: message.role, content: message.contentText });
      continue;
    }
    const parts: Array<
      | { type: "text"; text: string }
      | { type: "image_url"; image_url: { url: string } }
    > = [];
    if (message.contentText) {
      parts.push({ type: "text", text: message.contentText });
    }
    for (const imageId of message.imageIds) {
      const asset = await getImageAsset(imageId);
      if (!asset) continue;
      const url = await blobToDataUrl(asset.blob);
      parts.push({ type: "image_url", image_url: { url } });
    }
    // Convert system messages with images to user messages
    // Many providers (e.g., OpenAI) don't support images in system messages
    const role = message.role === "system" ? "user" : message.role;
    output.push({ role, content: parts });
  }

  // If no messages yet but we have a system message, add it
  if (
    hasSystemMessage &&
    output.length === 0 &&
    !systemMessageAdded.has(modelId)
  ) {
    output.push({ role: "system", content: matchingDefault!.systemMessage! });
  }

  return output;
}

async function getImageAsset(id: string): Promise<ImageAsset | null> {
  return await getImage(id);
}

function updateConversationTotals(
  conversation: Conversation,
  statsByModel: Record<string, ConversationStats>,
) {
  const totals = Object.values(statsByModel).reduce(
    (acc, stat) => {
      acc.tokens +=
        (toNumber(stat.inputTokens) ?? 0) + (toNumber(stat.outputTokens) ?? 0);
      acc.cost += toNumber(stat.totalCost) ?? 0;
      return acc;
    },
    { tokens: 0, cost: 0 },
  );
  conversation.totalTokens = totals.tokens;
  conversation.totalCost = totals.cost;
  conversation.messageCount = Object.values(
    $activeConversation.get().messagesByModel,
  ).reduce((count, list) => count + list.length, 0);
  conversation.updatedAt = Date.now();
}

export async function initializeConversation() {
  const settings = $settings.get();
  const modelIds = settings.selectedModelIds;
  const newConversation = createEmptyConversation(modelIds);
  const statsByModel = modelIds.reduce<Record<string, ConversationStats>>(
    (acc, modelId) => {
      acc[modelId] = {
        conversationId: newConversation.id,
        modelId,
        inputTokens: 0,
        outputTokens: 0,
        totalCost: 0,
      };
      return acc;
    },
    {},
  );
  setActiveConversation(newConversation.id);
  $activeConversation.set({
    conversation: newConversation,
    messagesByModel: {},
    statsByModel,
    streamingByModel: {},
    errorsByModel: {},
  });
}

export async function loadConversation(
  id: string,
  options?: { applyModelsToSettings?: boolean },
) {
  const applyModelsToSettings = options?.applyModelsToSettings ?? true;
  const conversation = await getConversation(id);
  if (!conversation) return;
  const messagesByModel: Record<string, Message[]> = {};
  const streamingByModel: Record<string, boolean> = {};

  for (const modelId of conversation.modelIds) {
    const messages = await getMessages(conversation.id, modelId);
    messagesByModel[modelId] = messages;

    // Check if any messages are currently streaming for this model
    const hasStreaming = messages.some(
      (msg) => msg.status === "streaming" && msg.role === "assistant",
    );
    if (hasStreaming) {
      streamingByModel[modelId] = true;
    }

    messages.forEach((message) => {
      if (message.role === "system" || message.role === "tool") {
        toggleCollapsedMessage(message.id, true);
      }
    });
  }
  const stats = await getStats(conversation.id);
  const statsByModel = stats.reduce<Record<string, ConversationStats>>(
    (acc, stat) => {
      acc[stat.modelId] = stat;
      return acc;
    },
    {},
  );
  const missingStats: ConversationStats[] = [];
  conversation.modelIds.forEach((modelId) => {
    if (statsByModel[modelId]) return;
    const stat: ConversationStats = {
      conversationId: conversation.id,
      modelId,
      inputTokens: 0,
      outputTokens: 0,
      totalCost: 0,
    };
    statsByModel[modelId] = stat;
    missingStats.push(stat);
  });
  if (missingStats.length) {
    await Promise.all(missingStats.map((stat) => saveStats(stat)));
  }
  setActiveConversation(conversation.id);
  $activeConversation.set({
    conversation,
    messagesByModel,
    statsByModel,
    streamingByModel,
    errorsByModel: {},
  });
  upsertHistoryConversation(conversation);
  if (applyModelsToSettings) {
    await setSelectedModels(conversation.modelIds);
  }
}

export async function resetConversation() {
  await initializeConversation();
}

export async function loadHistory() {
  const results = await listConversations(0, 20);
  const empty = results.filter(
    (item) =>
      !item.hasRun &&
      item.messageCount === 0 &&
      item.totalTokens === 0 &&
      item.totalCost === 0,
  );
  if (empty.length) {
    await Promise.all(
      empty.map(async (item) => {
        try {
          await deleteConversationDb(item.id);
        } catch {
          // ignore
        }
      }),
    );
  }
  const filtered = results.filter(
    (item) => item.hasRun || (item.messageCount > 0 && item.totalTokens > 0),
  );
  $history.set(filtered);
  setHistoryHasMore(results.length === 20);
  resetHistoryPagination();
}

export async function loadMoreHistory(offset: number) {
  const results = await listConversations(offset, 20);
  const filtered = results.filter(
    (item) => item.hasRun || (item.messageCount > 0 && item.totalTokens > 0),
  );
  $history.set([...$history.get(), ...filtered]);
  setHistoryHasMore(results.length === 20);
}

export async function deleteConversation(id: string) {
  deletedConversationIds.add(id);
  await deleteConversationDb(id);
  $history.set($history.get().filter((item) => item.id !== id));
  if ($activeConversationId.get() === id) {
    await initializeConversation();
  }
  await loadHistory();
}

export async function exportConversation(id: string) {
  const conversation = await getConversation(id);
  if (!conversation) return;
  const messagesByModel: Record<string, Message[]> = {};
  const images: Record<string, ImageAsset> = {};
  for (const modelId of conversation.modelIds) {
    const messages = await getMessages(id, modelId);
    messagesByModel[modelId] = messages;
    for (const message of messages) {
      for (const imageId of message.imageIds) {
        if (images[imageId]) continue;
        const asset = await getImageAsset(imageId);
        if (asset) images[imageId] = asset;
      }
    }
  }
  const blob = await exportConversationZip({
    conversation,
    messagesByModel,
    images,
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `conversation-${conversation.id}.zip`;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function addMessageToModel({
  conversation,
  modelId,
  role,
  contentText,
  imageIds,
  status = "complete",
  error,
  runIndex,
}: {
  conversation: Conversation;
  modelId: string;
  role: MessageRole;
  contentText: string;
  imageIds: string[];
  status?: Message["status"];
  error?: string;
  runIndex?: number;
}): Promise<Message> {
  const now = Date.now();
  const message: Message = {
    id: createId("message"),
    conversationId: conversation.id,
    modelId,
    role,
    contentText,
    imageIds,
    createdAt: now,
    updatedAt: now,
    status,
    error,
    runIndex,
  };
  await saveMessage(message);
  if (role === "system" || role === "tool") {
    toggleCollapsedMessage(message.id, true);
  }
  // Reasoning and thinking blocks are expanded by default to show streaming content
  // Users can collapse them manually if desired
  const state = $activeConversation.get();
  const list = state.messagesByModel[modelId] ?? [];
  $activeConversation.set({
    ...state,
    messagesByModel: {
      ...state.messagesByModel,
      [modelId]: [...list, message],
    },
  });
  updateConversationTotals(conversation, state.statsByModel);
  persistConversationDebounced(conversation);
  return message;
}

async function saveImageFromFile(file: File, size: number): Promise<string> {
  const loaded = await loadImageFromFile(file);
  const canvas = centerCropSquare(loaded, size);
  const blob = await canvasToBlob(canvas, file.type || "image/png");
  const asset: ImageAsset = {
    id: createId("image"),
    blob,
    mimeType: blob.type || "image/png",
    width: canvas.width,
    height: canvas.height,
    bytes: blob.size,
    createdAt: Date.now(),
  };
  await saveImage(asset);
  return asset.id;
}

export async function pushMessageToAll(input: InputState, size = 512) {
  const conversation = $activeConversation.get().conversation;
  const settings = $settings.get();
  const uiState = $uiState.get();
  if (!conversation || settings.selectedModelIds.length === 0) return;
  if (!input.text.trim() && input.pendingImages.length === 0) return;

  // If any models are solo'd, only send to those; otherwise send to all selected
  const targetModelIds =
    uiState.soloModelIds.size > 0
      ? settings.selectedModelIds.filter((id) => uiState.soloModelIds.has(id))
      : settings.selectedModelIds;

  if (targetModelIds.length === 0) return;

  const imageIds: string[] = [];
  for (const pending of input.pendingImages) {
    const id = await saveImageFromFile(pending.file, pending.size ?? size);
    imageIds.push(id);
  }
  await Promise.all(
    targetModelIds.map((modelId) =>
      addMessageToModel({
        conversation,
        modelId,
        role: input.role,
        contentText: input.text,
        imageIds,
      }),
    ),
  );
}

export async function sendMessageToAll(input: InputState, size = 512) {
  const conversation = $activeConversation.get().conversation;
  const settings = $settings.get();
  const uiState = $uiState.get();
  if (!conversation || settings.selectedModelIds.length === 0) return;
  if (!input.text.trim() && input.pendingImages.length === 0) return;

  // If any models are solo'd, only send to those; otherwise send to all selected
  const targetModelIds =
    uiState.soloModelIds.size > 0
      ? settings.selectedModelIds.filter((id) => uiState.soloModelIds.has(id))
      : settings.selectedModelIds;

  if (targetModelIds.length === 0) return;

  const imageIds: string[] = [];
  for (const pending of input.pendingImages) {
    const id = await saveImageFromFile(pending.file, pending.size ?? size);
    imageIds.push(id);
  }
  await Promise.all(
    targetModelIds.map((modelId) =>
      addMessageToModel({
        conversation,
        modelId,
        role: input.role,
        contentText: input.text,
        imageIds,
      }),
    ),
  );
  const multiplier = input.multiplier ?? 1;
  await Promise.all(
    targetModelIds.flatMap((modelId) =>
      Array.from({ length: multiplier }, (_, index) =>
        requestCompletionForModel(
          conversation,
          modelId,
          index + 1, // Always assign runIndex (1, 2, 3, etc.) for consistency
        ),
      ),
    ),
  );
}

async function requestCompletionForModel(
  conversation: Conversation,
  modelId: string,
  runIndex?: number,
) {
  const settings = $settings.get();
  if (!settings.apiKey) return;
  const requestMessages = await buildOpenRouterMessages(
    conversation.id,
    modelId,
  );
  const assistantMessage = await addMessageToModel({
    conversation,
    modelId,
    role: "assistant",
    contentText: "",
    imageIds: [],
    status: "streaming",
    runIndex,
  });
  const controller = new AbortController();
  // Use composite key for per-run abort controllers
  const controllerKey = `${modelId}-${runIndex}`;
  streamControllers.set(controllerKey, controller);
  {
    const next = $activeConversation.get();
    $activeConversation.set({
      ...next,
      streamingByModel: { ...next.streamingByModel, [modelId]: true },
      errorsByModel: { ...next.errorsByModel, [modelId]: null },
    });
  }
  await ensureStatsForModel(conversation.id, modelId);
  const parameterOverrides = settings.perModelParameters[modelId] ?? {};
  const normalizedOverrides: Record<string, unknown> = {};
  Object.entries(parameterOverrides).forEach(([key, value]) => {
    if (
      key === "overrideTemperature" ||
      key === "temperature" ||
      key === "top_p" ||
      key === "top_k" ||
      key === "max_tokens" ||
      key === "frequency_penalty" ||
      key === "presence_penalty"
    ) {
      normalizedOverrides[key] = value;
      return;
    }
    if (key === "topP") normalizedOverrides.top_p = value;
    else if (key === "topK") normalizedOverrides.top_k = value;
    else if (key === "maxTokens") normalizedOverrides.max_tokens = value;
    else if (key === "frequencyPenalty")
      normalizedOverrides.frequency_penalty = value;
    else if (key === "presencePenalty")
      normalizedOverrides.presence_penalty = value;
    else normalizedOverrides[key] = value;
  });

  // Infer and set modalities based on model capabilities
  // modalities is used for enabling image generation, not transforms
  // Allow user override via parameterOverrides.modalities
  const models = $models.get();
  const modelInfo = models.find((m) => m.id === modelId);
  const inferredModalities = modelInfo
    ? inferModelModalities(modelInfo)
    : ["text"]; // Default to text-only if model not found

  // Use user override if provided, otherwise use inferred modalities
  const modalities =
    normalizedOverrides.modalities &&
    Array.isArray(normalizedOverrides.modalities)
      ? normalizedOverrides.modalities
      : inferredModalities;

  // Some models (like image generation models) don't support certain parameters
  // Check if this is an image-only generation model
  const modelName = modelInfo?.name?.toLowerCase() ?? modelId.toLowerCase();
  const isImageOnlyModel =
    /^(openai\/gpt-.*image|dall|midjourney|stable.*diffusion|flux|imagen)/i.test(
      modelId,
    ) || /gpt-.*image/i.test(modelName);

  // Check for matching default to get streamReasoning, reasoningEffort, and temperature settings
  const matchingDefault = getMatchingDefault(modelId);
  const streamReasoningSet = matchingDefault?.streamReasoningSet ?? false;
  const streamReasoning = streamReasoningSet
    ? (matchingDefault?.streamReasoning ?? true)
    : true; // Default to true if not set
  const captureReasoningTraces = !(streamReasoningSet && !streamReasoning);
  const reasoningEffort = matchingDefault?.reasoningEffort; // May be undefined
  const reasoningEffortSet = matchingDefault?.reasoningEffortSet ?? false;
  const defaultTemperature = matchingDefault?.temperature; // May be undefined
  const temperatureSet = matchingDefault?.temperatureSet ?? false;

  // Build payload - exclude unsupported parameters for image-only models
  const payload: Record<string, unknown> = {
    model: modelId,
    messages: requestMessages,
    modalities,
    // Request usage data for cost tracking
    includeUsage: true,
    include_usage: true,
    stream_options: { include_usage: true },
  };

  // Request reasoning/thinking output for models that support it (e.g., Gemini, o1)
  // Only if streamReasoningSet is true AND streamReasoning is enabled AND reasoningEffortSet is true AND reasoningEffort is set
  if (
    streamReasoningSet &&
    streamReasoning &&
    reasoningEffortSet &&
    reasoningEffort
  ) {
    payload.reasoning = {
      effort: reasoningEffort,
    };
  }

  // Only add temperature if override is enabled or default temperature is set
  if (!isImageOnlyModel) {
    const overrideTemperature = normalizedOverrides.overrideTemperature;
    if (overrideTemperature === true) {
      // Per-model override takes precedence
      const temp = toNumber(normalizedOverrides.temperature);
      if (temp !== undefined) payload.temperature = temp;
    } else if (temperatureSet && defaultTemperature !== undefined) {
      // Use default temperature if set and no per-model override
      payload.temperature = defaultTemperature;
    }

    // Still handle other parameters if they exist (from model schemas)
    const topP = toNumber(normalizedOverrides.top_p);
    if (topP !== undefined) payload.top_p = topP;

    const topK = toNumber(normalizedOverrides.top_k);
    if (topK !== undefined) payload.top_k = topK;

    const maxTokens = toNumber(normalizedOverrides.max_tokens);
    if (maxTokens !== undefined) payload.max_tokens = maxTokens;

    const freqPenalty = toNumber(normalizedOverrides.frequency_penalty);
    if (freqPenalty !== undefined) payload.frequency_penalty = freqPenalty;

    const presPenalty = toNumber(normalizedOverrides.presence_penalty);
    if (presPenalty !== undefined) payload.presence_penalty = presPenalty;
  } else {
    // For image-only models, only include max_tokens if explicitly set
    const maxTokens = toNumber(normalizedOverrides.max_tokens);
    if (maxTokens !== undefined) payload.max_tokens = maxTokens;
    if (import.meta.env.DEV) {
      console.debug(
        `[Conversation] Excluding text generation parameters for image-only model: ${modelId}`,
      );
    }
  }

  // Add any other custom parameters from overrides (but exclude the ones we already handled)
  Object.entries(normalizedOverrides).forEach(([key, value]) => {
    if (
      key !== "overrideTemperature" &&
      key !== "temperature" &&
      key !== "top_p" &&
      key !== "top_k" &&
      key !== "max_tokens" &&
      key !== "frequency_penalty" &&
      key !== "presence_penalty" &&
      key !== "modalities" &&
      value !== undefined
    ) {
      payload[key] = value;
    }
  });

  if (import.meta.env.DEV) {
    console.debug(
      `[Conversation] Request payload for ${modelId}:`,
      JSON.stringify(
        {
          model: payload.model,
          modalities: payload.modalities,
          messageCount: (payload.messages as OpenRouterMessage[]).length,
          reasoning: payload.reasoning,
          temperature: payload.temperature,
          max_tokens: payload.max_tokens,
        },
        null,
        2,
      ),
    );
  }
  let usage: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_cost?: number;
  } = {};
  let sawOutput = false;
  let abortForFallback = false;
  let fallbackRan = false;
  const pendingAttachments: OpenRouterAttachment[] = [];
  const pendingImageUrls: string[] = [];
  let lastReceivedImageUrl: string | null = null;

  const keepOnlyLastImage = Boolean(
    matchingDefault?.keepOnlyLastImageSet && matchingDefault.keepOnlyLastImage,
  );

  const applyAssistantUpdate = async () => {
    // Create a fresh copy to ensure reactivity, preserving all fields including runIndex
    // The spread operator should preserve runIndex, but we explicitly ensure it
    const messageCopy: Message = {
      ...assistantMessage,
      runIndex: assistantMessage.runIndex, // Explicitly preserve runIndex
    };
    await saveMessage(messageCopy);
    const current = $activeConversation.get();
    const list = current.messagesByModel[modelId] ?? [];
    const messageIndex = list.findIndex(
      (msg) => msg.id === assistantMessage.id,
    );
    const updatedList =
      messageIndex >= 0
        ? list.map((msg, idx) => (idx === messageIndex ? messageCopy : msg))
        : [...list, messageCopy];
    $activeConversation.set({
      ...current,
      messagesByModel: { ...current.messagesByModel, [modelId]: updatedList },
    });
    if (import.meta.env.DEV) {
      console.debug(
        `[Conversation] Updated message ${assistantMessage.id} for ${modelId} (runIndex: ${runIndex}):`,
        {
          contentTextLength: messageCopy.contentText?.length ?? 0,
          contentTextPreview: messageCopy.contentText?.substring(0, 100),
          imageIds: messageCopy.imageIds.length,
          status: messageCopy.status,
          runIndex: messageCopy.runIndex,
        },
      );
    }
  };

  const finalizeWithStats = async () => {
    const current = $activeConversation.get();
    const list = current.messagesByModel[modelId] ?? [];
    const updatedList = list.some((msg) => msg.id === assistantMessage.id)
      ? list.map((msg) =>
          msg.id === assistantMessage.id ? assistantMessage : msg,
        )
      : [...list, assistantMessage];
    const stats = current.statsByModel[modelId] ?? {
      conversationId: conversation.id,
      modelId,
      inputTokens: 0,
      outputTokens: 0,
      totalCost: 0,
    };

    const promptTokens = toNumber(usage.prompt_tokens) ?? 0;
    const completionTokens = toNumber(usage.completion_tokens) ?? 0;

    // Calculate cost: use API-provided total_cost, or calculate from model pricing.
    // For image models, include per-image and per-request pricing.
    let calculatedCost = toNumber(usage.total_cost) ?? 0;
    if (!calculatedCost) {
      const models = $models.get();
      const modelInfo = models.find((m) => m.id === modelId);
      calculatedCost = calculateModelCostUsd({
        pricing: modelInfo?.pricing,
        promptTokens,
        completionTokens,
        outputImages: assistantMessage.imageIds.length,
      });
    }

    if (import.meta.env.DEV) {
      console.debug(`[Conversation] Finalizing stats for ${modelId}:`, {
        previousStats: stats,
        usage,
        calculatedCost,
      });
    }

    const nextStats: ConversationStats = {
      ...stats,
      inputTokens: (toNumber(stats.inputTokens) ?? 0) + promptTokens,
      outputTokens: (toNumber(stats.outputTokens) ?? 0) + completionTokens,
      totalCost: (toNumber(stats.totalCost) ?? 0) + calculatedCost,
    };
    await saveStats(nextStats);
    // Check if any other runs are still streaming for this model
    const stillStreaming = Array.from(streamControllers.keys()).some((key) =>
      key.startsWith(`${modelId}-`),
    );
    const nextState: ActiveConversationState = {
      ...current,
      messagesByModel: { ...current.messagesByModel, [modelId]: updatedList },
      statsByModel: { ...current.statsByModel, [modelId]: nextStats },
      streamingByModel: {
        ...current.streamingByModel,
        [modelId]: stillStreaming,
      },
    };
    updateConversationTotals(conversation, nextState.statsByModel);
    if (!conversation.hasRun) {
      conversation.hasRun = true;
      conversation.firstRunAt = conversation.firstRunAt ?? Date.now();
    }
    $activeConversation.set(nextState);
    if (!deletedConversationIds.has(conversation.id)) {
      await saveConversation(conversation);
    }
    upsertHistoryConversation(conversation);
  };

  const runFallback = async () => {
    if (fallbackRan) return;
    fallbackRan = true;
    try {
      const result = await requestCompletionFull({
        apiKey: settings.apiKey,
        payload: payload as OpenRouterCompletionRequest,
      });
      if (result.usage) {
        const normalized = {
          prompt_tokens: toNumber(result.usage.prompt_tokens),
          completion_tokens: toNumber(result.usage.completion_tokens),
          total_cost: toNumber(result.usage.total_cost),
        };
        usage = {
          prompt_tokens: normalized.prompt_tokens ?? usage.prompt_tokens,
          completion_tokens:
            normalized.completion_tokens ?? usage.completion_tokens,
          total_cost: normalized.total_cost ?? usage.total_cost,
        };
        // Calculate cost if not provided
        if (
          !usage.total_cost &&
          (usage.prompt_tokens || usage.completion_tokens)
        ) {
          const models = $models.get();
          const modelInfo = models.find((m) => m.id === modelId);
          if (modelInfo?.pricing) {
            const promptPricePerM = toNumber(modelInfo.pricing.prompt) ?? 0;
            const completionPricePerM =
              toNumber(modelInfo.pricing.completion) ?? 0;
            const requestPrice = toNumber(modelInfo.pricing.request) ?? 0;
            const promptCost =
              ((usage.prompt_tokens ?? 0) * promptPricePerM) / 1_000_000;
            const completionCost =
              ((usage.completion_tokens ?? 0) * completionPricePerM) /
              1_000_000;
            const requestCost = requestPrice;
            usage.total_cost = promptCost + completionCost + requestCost;
          }
        }
      }
      // Always set contentText, even if empty string
      assistantMessage.contentText = result.content.text ?? "";
      if (captureReasoningTraces) {
        if (result.reasoning?.reasoning) {
          assistantMessage.contentReasoning = result.reasoning.reasoning;
        }
        if (result.reasoning?.thinking) {
          assistantMessage.contentThinking = result.reasoning.thinking;
        }
      }
      if (result.attachments?.length) {
        pendingAttachments.push(...result.attachments);
        const urls = collectImageUrlsFromAttachments(result.attachments);
        if (urls.length > 0)
          lastReceivedImageUrl = urls[urls.length - 1] ?? null;
      }
      if (result.content.imageUrls.length > 0) {
        pendingImageUrls.push(...result.content.imageUrls);
        lastReceivedImageUrl =
          result.content.imageUrls[result.content.imageUrls.length - 1] ?? null;
      }
      const storedIds = await resolveAndStoreMessageImages({
        message: assistantMessage,
        imageUrls: keepOnlyLastImage
          ? lastReceivedImageUrl
            ? [lastReceivedImageUrl]
            : []
          : pendingImageUrls,
        attachments: keepOnlyLastImage ? [] : pendingAttachments,
        includeText: !keepOnlyLastImage,
        keepOnlyLast: keepOnlyLastImage,
      });
      const imagesStored = storedIds.length > 0;
      // Check for any content - even empty strings or whitespace-only text should be considered output
      // (the model might be saying "I can't do that" or similar)
      sawOutput =
        (assistantMessage.contentText !== undefined &&
          assistantMessage.contentText !== null &&
          assistantMessage.contentText.length > 0) ||
        Boolean(assistantMessage.contentReasoning?.trim()) ||
        Boolean(assistantMessage.contentThinking?.trim()) ||
        assistantMessage.imageIds.length > 0 ||
        pendingAttachments.length > 0 ||
        imagesStored;
      if (!sawOutput) {
        if (import.meta.env.DEV) {
          console.warn("[Conversation] No output detected:", {
            contentText: assistantMessage.contentText,
            contentReasoning: assistantMessage.contentReasoning,
            contentThinking: assistantMessage.contentThinking,
            imageIds: assistantMessage.imageIds,
            attachments: pendingAttachments,
          });
        }
        assistantMessage.error =
          "No visible output received (streaming + non-streaming). Try a different model.";
      }
      if (!assistantMessage.firstTokenAt) {
        assistantMessage.firstTokenAt = Date.now();
      }
      assistantMessage.status = "complete";
      assistantMessage.completedAt = Date.now();
      assistantMessage.updatedAt = Date.now();
      await applyAssistantUpdate();
      await finalizeWithStats();
    } catch (error) {
      assistantMessage.status = "error";
      assistantMessage.completedAt = Date.now();
      assistantMessage.error = (error as Error).message;
      assistantMessage.updatedAt = Date.now();
      await applyAssistantUpdate();
      const current = $activeConversation.get();
      // Check if any other runs are still streaming for this model
      const stillStreaming = Array.from(streamControllers.keys()).some((key) =>
        key.startsWith(`${modelId}-`),
      );
      $activeConversation.set({
        ...current,
        streamingByModel: {
          ...current.streamingByModel,
          [modelId]: stillStreaming,
        },
        errorsByModel: {
          ...current.errorsByModel,
          [modelId]: (error as Error).message,
        },
      });
    }
  };

  const fallbackTimeout = window.setTimeout(() => {
    if (sawOutput || fallbackRan) return;
    abortForFallback = true;
    try {
      controller.abort();
    } finally {
      void runFallback();
    }
  }, 45000);
  try {
    await streamCompletion({
      apiKey: settings.apiKey,
      payload: payload as OpenRouterCompletionRequest,
      signal: controller.signal,
      onToken: async (token) => {
        sawOutput = true;
        if (!assistantMessage.firstTokenAt) {
          assistantMessage.firstTokenAt = Date.now();
        }
        // Ensure we always have a string, even if empty
        const currentText = assistantMessage.contentText ?? "";
        assistantMessage.contentText = currentText + token;
        assistantMessage.updatedAt = Date.now();
        if (import.meta.env.DEV) {
          console.debug(`[Conversation] Token received for ${modelId}:`, {
            tokenPreview: token.substring(0, 50),
            totalLength: assistantMessage.contentText.length,
          });
        }
        await applyAssistantUpdate();
      },
      onReasoningToken: async (token) => {
        sawOutput = true;
        const didSetFirstTokenAt = !assistantMessage.firstTokenAt;
        if (!assistantMessage.firstTokenAt) {
          assistantMessage.firstTokenAt = Date.now();
        }
        if (!captureReasoningTraces) {
          if (didSetFirstTokenAt) {
            assistantMessage.updatedAt = Date.now();
            await applyAssistantUpdate();
          }
          return;
        }
        assistantMessage.contentReasoning =
          (assistantMessage.contentReasoning ?? "") + token;
        assistantMessage.updatedAt = Date.now();
        if (import.meta.env.DEV) {
          console.debug(
            `[Conversation] Reasoning token for ${modelId}:`,
            token.substring(0, 100),
          );
        }
        await applyAssistantUpdate();
      },
      onThinkingToken: async (token) => {
        sawOutput = true;
        const didSetFirstTokenAt = !assistantMessage.firstTokenAt;
        if (!assistantMessage.firstTokenAt) {
          assistantMessage.firstTokenAt = Date.now();
        }
        if (!captureReasoningTraces) {
          if (didSetFirstTokenAt) {
            assistantMessage.updatedAt = Date.now();
            await applyAssistantUpdate();
          }
          return;
        }
        assistantMessage.contentThinking =
          (assistantMessage.contentThinking ?? "") + token;
        assistantMessage.updatedAt = Date.now();
        if (import.meta.env.DEV) {
          console.debug(
            `[Conversation] Thinking token for ${modelId}:`,
            token.substring(0, 100),
          );
        }
        await applyAssistantUpdate();
      },
      onMessage: async (message) => {
        if (import.meta.env.DEV) {
          console.debug(`[Conversation] Message callback for ${modelId}:`, {
            textLength: message.text?.length ?? 0,
            textPreview: message.text?.substring(0, 100),
            imageUrls: message.imageUrls.length,
            imageUrlsList: message.imageUrls,
            attachments: message.attachments?.length ?? 0,
          });
        }

        if (
          !assistantMessage.firstTokenAt &&
          (message.imageUrls.length > 0 ||
            (message.attachments?.length ?? 0) > 0)
        ) {
          assistantMessage.firstTokenAt = Date.now();
          assistantMessage.updatedAt = Date.now();
          await applyAssistantUpdate();
        }

        // Accumulate images/attachments and resolve them onDone. Providers can repeat the exact same URL
        // across chunks (including identical data URLs), so we collapse at the end.
        if (message.attachments?.length) {
          if (!keepOnlyLastImage) {
            pendingAttachments.push(...message.attachments);
          }
          const urls = collectImageUrlsFromAttachments(message.attachments);
          if (urls.length > 0)
            lastReceivedImageUrl = urls[urls.length - 1] ?? null;
          sawOutput = true;
        }
        if (message.imageUrls.length > 0) {
          if (!keepOnlyLastImage) {
            pendingImageUrls.push(...message.imageUrls);
          }
          lastReceivedImageUrl =
            message.imageUrls[message.imageUrls.length - 1] ?? null;
          sawOutput = true;
        }
      },
      onUsage: (nextUsage) => {
        if (import.meta.env.DEV) {
          console.debug(
            `[Conversation] Usage update for ${modelId}:`,
            nextUsage,
          );
        }
        const normalized = {
          prompt_tokens: toNumber(nextUsage.prompt_tokens),
          completion_tokens: toNumber(nextUsage.completion_tokens),
          total_cost: toNumber(nextUsage.total_cost),
        };
        usage = {
          prompt_tokens: normalized.prompt_tokens ?? usage.prompt_tokens,
          completion_tokens:
            normalized.completion_tokens ?? usage.completion_tokens,
          total_cost: normalized.total_cost ?? usage.total_cost,
        };
      },
      onError: async (error) => {
        if (import.meta.env.DEV) {
          console.error(`[Conversation] Stream error for ${modelId}:`, error);
        }
        if (abortForFallback) return;
        assistantMessage.status = "error";
        assistantMessage.completedAt = Date.now();
        assistantMessage.error = error.message;
        assistantMessage.updatedAt = Date.now();
        await applyAssistantUpdate();
        const current = $activeConversation.get();
        $activeConversation.set({
          ...current,
          errorsByModel: { ...current.errorsByModel, [modelId]: error.message },
        });
      },
      onDone: async () => {
        window.clearTimeout(fallbackTimeout);
        if (import.meta.env.DEV) {
          console.debug(`[Conversation] Stream done for ${modelId}`, {
            contentTextLength: assistantMessage.contentText?.length ?? 0,
            imageIds: assistantMessage.imageIds.length,
            attachments: pendingAttachments.length,
            sawOutput,
            hasReasoning: Boolean(assistantMessage.contentReasoning?.trim()),
            hasThinking: Boolean(assistantMessage.contentThinking?.trim()),
            isImageOnlyModel,
          });
        }

        const storedIds = await resolveAndStoreMessageImages({
          message: assistantMessage,
          imageUrls: keepOnlyLastImage
            ? lastReceivedImageUrl
              ? [lastReceivedImageUrl]
              : []
            : pendingImageUrls,
          attachments: keepOnlyLastImage ? [] : pendingAttachments,
          includeText: !keepOnlyLastImage,
          keepOnlyLast: keepOnlyLastImage,
        });
        if (storedIds.length > 0) {
          await applyAssistantUpdate();
        }
        const imagesStored = storedIds.length > 0;
        if (import.meta.env.DEV && imagesStored) {
          console.debug(
            `[Conversation] Stored ${storedIds.length} image(s) for ${modelId}`,
          );
        }

        // Check for any content - check if contentText exists and has length
        const hasText =
          assistantMessage.contentText !== undefined &&
          assistantMessage.contentText !== null &&
          assistantMessage.contentText.length > 0;

        const hasReasoning = Boolean(assistantMessage.contentReasoning?.trim());
        const hasThinking = Boolean(assistantMessage.contentThinking?.trim());
        const hasImages = assistantMessage.imageIds.length > 0;
        const hasAttachments = pendingAttachments.length > 0;

        // Update sawOutput to include images resolved at stream end
        // CRITICAL: Reasoning/thinking counts as output even if no images/text
        sawOutput =
          sawOutput ||
          hasText ||
          hasReasoning ||
          hasThinking ||
          hasImages ||
          hasAttachments ||
          imagesStored;

        if (import.meta.env.DEV) {
          console.debug(`[Conversation] Stream done check for ${modelId}:`, {
            sawOutput,
            hasText,
            contentTextLength: assistantMessage.contentText?.length ?? 0,
            contentTextPreview: assistantMessage.contentText?.substring(0, 100),
            imageIds: assistantMessage.imageIds.length,
            attachments: pendingAttachments.length,
            imagesStored,
            hasReasoning: Boolean(assistantMessage.contentReasoning?.trim()),
            hasThinking: Boolean(assistantMessage.contentThinking?.trim()),
            isImageOnlyModel,
            usage: usage.completion_tokens
              ? { outputTokens: usage.completion_tokens }
              : null,
          });
        }

        if (!sawOutput) {
          if (import.meta.env.DEV) {
            console.warn(
              `[Conversation] Stream completed with no output for ${modelId}:`,
              {
                contentText: assistantMessage.contentText,
                contentReasoning: assistantMessage.contentReasoning,
                contentThinking: assistantMessage.contentThinking,
                imageIds: assistantMessage.imageIds,
                attachments: pendingAttachments,
                isImageOnlyModel,
              },
            );
          }
          await runFallback();
          return;
        }
        assistantMessage.status = "complete";
        assistantMessage.completedAt = Date.now();
        assistantMessage.updatedAt = Date.now();
        await applyAssistantUpdate();
        await finalizeWithStats();
      },
    });
  } catch (error) {
    window.clearTimeout(fallbackTimeout);
    if (abortForFallback) return;
    assistantMessage.status = "error";
    assistantMessage.completedAt = Date.now();
    assistantMessage.error = (error as Error).message;
    assistantMessage.updatedAt = Date.now();
    await applyAssistantUpdate();
    const current = $activeConversation.get();
    $activeConversation.set({
      ...current,
      streamingByModel: { ...current.streamingByModel, [modelId]: false },
      errorsByModel: {
        ...current.errorsByModel,
        [modelId]: (error as Error).message,
      },
    });
  } finally {
    window.clearTimeout(fallbackTimeout);
    const controllerKey = `${modelId}-${runIndex}`;
    streamControllers.delete(controllerKey);
  }
}

function toNumber(value: unknown) {
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export async function abortStream(modelId: string, runIndex?: number) {
  // If runIndex is provided, abort only that specific run
  // Otherwise, abort all runs for this model
  if (runIndex !== undefined) {
    const controllerKey = `${modelId}-${runIndex}`;
    const controller = streamControllers.get(controllerKey);
    if (controller) {
      controller.abort();
      streamControllers.delete(controllerKey);
      const state = $activeConversation.get();
      // Check if any other runs are still streaming for this model
      const stillStreaming = Array.from(streamControllers.keys()).some((key) =>
        key.startsWith(`${modelId}-`),
      );
      $activeConversation.set({
        ...state,
        streamingByModel: {
          ...state.streamingByModel,
          [modelId]: stillStreaming,
        },
      });
    }
  } else {
    // Abort all runs for this model
    const keysToDelete: string[] = [];
    streamControllers.forEach((controller, key) => {
      if (key.startsWith(`${modelId}-`)) {
        controller.abort();
        keysToDelete.push(key);
      }
    });
    keysToDelete.forEach((key) => streamControllers.delete(key));
    const state = $activeConversation.get();
    $activeConversation.set({
      ...state,
      streamingByModel: { ...state.streamingByModel, [modelId]: false },
    });
  }
}

export async function removeMessageFromModel(
  modelId: string,
  messageId: string,
  runIndex?: number,
) {
  const conversation = $activeConversation.get().conversation;
  if (!conversation) return;

  // Get the message to check if it's a user message (shared across runs)
  const messages = await getMessages(conversation.id, modelId);
  const messageToDelete = messages.find((msg) => msg.id === messageId);

  if (messageToDelete && messageToDelete.runIndex === undefined) {
    // User message without runIndex - check if it's used by other runs
    const hasOtherRuns = messages.some(
      (msg) =>
        msg.id !== messageId &&
        msg.runIndex !== undefined &&
        messages.findIndex((m) => m.id === messageId) <
          messages.findIndex((m) => m.id === msg.id),
    );
    if (hasOtherRuns && runIndex !== undefined) {
      // User message is used by other runs - only delete assistant messages for this run
      // Find the first assistant message for this run after the user message
      const userMessageIndex = messages.findIndex((m) => m.id === messageId);
      const firstAssistantForRun = messages.findIndex(
        (msg, idx) =>
          idx > userMessageIndex &&
          msg.runIndex === runIndex &&
          msg.role === "assistant",
      );
      if (firstAssistantForRun !== -1) {
        await deleteMessagesAfter(
          conversation.id,
          modelId,
          messages[firstAssistantForRun].id,
          runIndex,
        );
      }
    } else {
      // No other runs using this user message, or runIndex not specified - delete normally
      await deleteMessagesAfter(conversation.id, modelId, messageId, runIndex);
    }
  } else {
    // Assistant message or runIndex specified - delete messages for this run
    await deleteMessagesAfter(conversation.id, modelId, messageId, runIndex);
  }

  const remaining = await getMessages(conversation.id, modelId);
  const state = $activeConversation.get();
  $activeConversation.set({
    ...state,
    messagesByModel: { ...state.messagesByModel, [modelId]: remaining },
  });
  updateConversationTotals(conversation, state.statsByModel);
  await saveConversation(conversation);
}

export async function rerunLastAssistantMessage(modelId: string) {
  const state = $activeConversation.get();
  const conversation = state.conversation;
  if (!conversation) return;

  const messages = state.messagesByModel[modelId] ?? [];
  if (messages.length === 0) return;

  // Find the last assistant message
  let lastAssistantIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "assistant") {
      lastAssistantIndex = i;
      break;
    }
  }
  if (lastAssistantIndex === -1) return;

  const lastAssistantMessage = messages[lastAssistantIndex];
  const hasMessageAfter = lastAssistantIndex < messages.length - 1;

  if (hasMessageAfter) {
    // If there's a message after the assistant (e.g., a user message),
    // delete only the assistant message, keeping messages after it
    await deleteMessage(lastAssistantMessage.id);
  } else {
    // If the assistant is the last message, delete it and everything after (nothing)
    await deleteMessagesAfter(
      conversation.id,
      modelId,
      lastAssistantMessage.id,
    );
  }

  // Reload messages and re-run completion
  const updatedMessages = await getMessages(conversation.id, modelId);
  $activeConversation.set({
    ...state,
    messagesByModel: { ...state.messagesByModel, [modelId]: updatedMessages },
  });

  // Re-run the completion
  await requestCompletionForModel(conversation, modelId);
}

export async function ensureConversationLoaded() {
  if (!$activeConversationId.get()) {
    await initializeConversation();
    return;
  }
  const conversation = await getConversation($activeConversationId.get()!);
  if (!conversation) {
    await initializeConversation();
  } else {
    await loadConversation(conversation.id);
  }
}

export async function syncConversationModels(modelIds: string[]) {
  const state = $activeConversation.get();
  const conversation = state.conversation;
  if (!conversation) return;
  const updatedConversation = { ...conversation, modelIds };
  const messagesByModel: Record<string, Message[]> = {};
  const statsByModel: Record<string, ConversationStats> = {};
  const missingStats: ConversationStats[] = [];
  for (const modelId of modelIds) {
    messagesByModel[modelId] = state.messagesByModel[modelId] ?? [];
    if (state.statsByModel[modelId]) {
      statsByModel[modelId] = state.statsByModel[modelId];
      continue;
    }
    const stat: ConversationStats = {
      conversationId: updatedConversation.id,
      modelId,
      inputTokens: 0,
      outputTokens: 0,
      totalCost: 0,
    };
    statsByModel[modelId] = stat;
    missingStats.push(stat);
  }
  if (updatedConversation.hasRun && missingStats.length) {
    await Promise.all(missingStats.map((stat) => saveStats(stat)));
  }
  $activeConversation.set({
    ...state,
    conversation: updatedConversation,
    messagesByModel,
    statsByModel,
  });
  if (
    updatedConversation.hasRun &&
    !deletedConversationIds.has(updatedConversation.id)
  ) {
    await saveConversation(updatedConversation);
  }
  upsertHistoryConversation(updatedConversation);
}
