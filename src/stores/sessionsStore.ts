import { atom, map } from "nanostores";
import type { Session, SessionStats, Message, MessageRole } from "../types/db";
import type {
  OpenRouterCompletionRequest,
  OpenRouterMessage,
} from "../types/openrouter";
import {
  deleteSession as deleteSessionDb,
  deleteMessage,
  deleteMessagesAfter,
  getSession,
  getImage,
  getMessages,
  getStats,
  listSessions,
  saveSession,
  saveImage,
  saveMessage,
  saveStats,
} from "../lib/idb";
import { createId, debounce } from "../lib/utils";
import type { OpenRouterAttachment } from "../lib/openrouter";
import {
  requestCompletionFull,
  streamCompletion,
  fetchGenerationCost,
} from "../lib/openrouter";
import {
  blobToDataUrl,
  canvasToBlob,
  centerCropSquare,
  loadImageFromFile,
} from "../lib/image";
import { exportSessionZip } from "../lib/export";
import {
  collectImageUrlsFromAttachments,
  resolveAndStoreMessageImages,
} from "../lib/session/messageImages";
import { calculateModelCostUsd } from "../lib/cost";
import { $settings, setSelectedModels } from "./settingsStore";
import { $activeSessionId, setActiveSession } from "./appStore";
import { $models } from "./modelsStore";
import { inferModelModalities } from "../lib/modelMeta";
import { getMatchingDefault } from "./defaultsStore";
import { $uiState, resetHistoryPagination, setHistoryHasMore } from "./uiStore";
import { showVerificationDialog } from "./verificationStore";
import type { InputState } from "./inputStore";
import type { ImageAsset } from "../types/db";

export interface ActiveSessionState {
  session: Session | null;
  messagesByModel: Record<string, Message[]>;
  statsByModel: Record<string, SessionStats>;
  streamingByModel: Record<string, boolean>;
  errorsByModel: Record<string, string | null>;
}

export const $activeSession = map<ActiveSessionState>({
  session: null,
  messagesByModel: {},
  statsByModel: {},
  streamingByModel: {},
  errorsByModel: {},
});

export const $history = atom<Session[]>([]);

// Map key format: `${modelId}-${runIndex}` for per-run abort controllers
const streamControllers = new Map<string, AbortController>();
const deletedSessionIds = new Set<string>();

function upsertHistorySession(session: Session) {
  if (!session.hasExecuted) return;
  const list = $history.get();
  if (list.length === 0) {
    $history.set([session]);
    return;
  }
  const next = [session, ...list.filter((item) => item.id !== session.id)]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, list.length);
  $history.set(next);
}

function createEmptySession(modelIds: string[]): Session {
  const now = Date.now();
  return {
    id: createId("session"),
    createdAt: now,
    updatedAt: now,
    modelIds,
    hasExecuted: false,
    messageCount: 0,
    totalTokens: 0,
    totalCost: 0,
  };
}

const persistSessionDebounced = debounce((session: Session) => {
  if (deletedSessionIds.has(session.id)) return;
  if (!session.hasExecuted) return;
  void saveSession(session);
  upsertHistorySession(session);
}, 500);

async function ensureStatsForModel(sessionId: string, modelId: string) {
  const current = $activeSession.get();
  if (current.statsByModel[modelId]) return;
  const stats: SessionStats = {
    sessionId,
    modelId,
    inputTokens: 0,
    outputTokens: 0,
    totalCost: 0,
  };
  $activeSession.set({
    ...current,
    statsByModel: { ...current.statsByModel, [modelId]: stats },
  });
}

async function buildOpenRouterMessages(
  sessionId: string,
  modelId: string,
  runIndex?: number,
): Promise<OpenRouterMessage[]> {
  const allMessages = await getMessages(sessionId, modelId);
  // Filter messages for this specific run - each run has its own copies
  // If runIndex is undefined, only include messages without runIndex (legacy support)
  const messages =
    runIndex !== undefined
      ? allMessages.filter((msg) => msg.runIndex === runIndex)
      : allMessages.filter((msg) => msg.runIndex === undefined);
  const output: OpenRouterMessage[] = [];

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

  return output;
}

async function getImageAsset(id: string): Promise<ImageAsset | null> {
  return await getImage(id);
}

/**
 * Ensures that a system message from defaults exists in the database for a given model and run.
 * This allows system messages to appear in the UI and persist across message sends.
 * Each run gets its own copy of the system message.
 */
async function ensureDefaultSystemMessage(
  session: Session,
  modelId: string,
  runIndex?: number,
): Promise<void> {
  // Check if a system message already exists for this model and run
  const existingMessages = await getMessages(session.id, modelId);
  const hasSystemMessage = existingMessages.some(
    (msg) => msg.role === "system" && msg.runIndex === runIndex,
  );
  if (hasSystemMessage) {
    return; // Already exists, don't create another
  }

  // Check for matching default with system message
  const matchingDefault = getMatchingDefault(modelId);
  const hasSystemMessageDefault =
    matchingDefault?.systemMessageSet && matchingDefault?.systemMessage?.trim();

  if (!hasSystemMessageDefault) {
    return; // No system message default for this model
  }

  // Create the system message for this run
  const now = Date.now();
  const systemMessage: Message = {
    id: createId("message"),
    sessionId: session.id,
    modelId,
    role: "system",
    contentText: matchingDefault!.systemMessage!,
    imageIds: [],
    createdAt: now,
    updatedAt: now,
    status: "complete",
    runIndex, // Each run gets its own copy
  };
  await saveMessage(systemMessage);

  // Add to UI state
  // System messages are revealed by default (not collapsed)
  const state = $activeSession.get();
  const list = state.messagesByModel[modelId] ?? [];
  // Insert at the beginning so it appears first
  $activeSession.set({
    ...state,
    messagesByModel: {
      ...state.messagesByModel,
      [modelId]: [systemMessage, ...list],
    },
  });
}

function updateSessionTotals(
  session: Session,
  statsByModel: Record<string, SessionStats>,
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
  session.totalTokens = totals.tokens;
  session.totalCost = totals.cost;
  session.messageCount = Object.values(
    $activeSession.get().messagesByModel,
  ).reduce((count, list) => count + list.length, 0);
  session.updatedAt = Date.now();
}

export async function initializeSession() {
  const settings = $settings.get();
  const modelIds = settings.selectedModelIds;
  const newSession = createEmptySession(modelIds);
  const statsByModel = modelIds.reduce<Record<string, SessionStats>>(
    (acc, modelId) => {
      acc[modelId] = {
        sessionId: newSession.id,
        modelId,
        inputTokens: 0,
        outputTokens: 0,
        totalCost: 0,
      };
      return acc;
    },
    {},
  );
  setActiveSession(newSession.id);
  $activeSession.set({
    session: newSession,
    messagesByModel: {},
    statsByModel,
    streamingByModel: {},
    errorsByModel: {},
  });

  // System messages will be created when runs start, not during initialization
}

export async function loadSession(
  id: string,
  options?: { applyModelsToSettings?: boolean },
) {
  const applyModelsToSettings = options?.applyModelsToSettings ?? true;
  const session = await getSession(id);
  if (!session) return;
  const messagesByModel: Record<string, Message[]> = {};
  const streamingByModel: Record<string, boolean> = {};

  for (const modelId of session.modelIds) {
    const messages = await getMessages(session.id, modelId);
    messagesByModel[modelId] = messages;

    // Check if any messages are currently streaming for this model
    const hasStreaming = messages.some(
      (msg) => msg.status === "streaming" && msg.role === "assistant",
    );
    if (hasStreaming) {
      streamingByModel[modelId] = true;
    }

    // Messages are shown by default; users can hide them with the eye icon
  }
  const stats = await getStats(session.id);
  const statsByModel = stats.reduce<Record<string, SessionStats>>(
    (acc, stat) => {
      acc[stat.modelId] = stat;
      return acc;
    },
    {},
  );
  const missingStats: SessionStats[] = [];
  session.modelIds.forEach((modelId) => {
    if (statsByModel[modelId]) return;
    const stat: SessionStats = {
      sessionId: session.id,
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
  setActiveSession(session.id);
  $activeSession.set({
    session,
    messagesByModel,
    statsByModel,
    streamingByModel,
    errorsByModel: {},
  });
  upsertHistorySession(session);
  if (applyModelsToSettings) {
    await setSelectedModels(session.modelIds);
  }
}

export async function resetSession() {
  await initializeSession();
}

export async function loadHistory() {
  const results = await listSessions(0, 20);
  const empty = results.filter(
    (item) =>
      !item.hasExecuted &&
      item.messageCount === 0 &&
      item.totalTokens === 0 &&
      item.totalCost === 0,
  );
  if (empty.length) {
    await Promise.all(
      empty.map(async (item) => {
        try {
          await deleteSessionDb(item.id);
        } catch {
          // ignore
        }
      }),
    );
  }
  const filtered = results.filter(
    (item) =>
      item.hasExecuted || (item.messageCount > 0 && item.totalTokens > 0),
  );
  $history.set(filtered);
  setHistoryHasMore(results.length === 20);
  resetHistoryPagination();
}

export async function loadMoreHistory(offset: number) {
  const results = await listSessions(offset, 20);
  const filtered = results.filter(
    (item) =>
      item.hasExecuted || (item.messageCount > 0 && item.totalTokens > 0),
  );
  $history.set([...$history.get(), ...filtered]);
  setHistoryHasMore(results.length === 20);
}

export async function deleteSession(id: string) {
  deletedSessionIds.add(id);
  await deleteSessionDb(id);
  $history.set($history.get().filter((item) => item.id !== id));
  if ($activeSessionId.get() === id) {
    await initializeSession();
  }
  await loadHistory();
}

export async function exportSession(id: string) {
  const session = await getSession(id);
  if (!session) return;
  const messagesByModel: Record<string, Message[]> = {};
  const images: Record<string, ImageAsset> = {};
  for (const modelId of session.modelIds) {
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
  const blob = await exportSessionZip({
    session,
    messagesByModel,
    images,
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `session-${session.id}.zip`;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function addMessageToModel({
  session,
  modelId,
  role,
  contentText,
  imageIds,
  status = "complete",
  error,
  runIndex,
}: {
  session: Session;
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
    sessionId: session.id,
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
  // Messages are shown by default; users can hide them with the eye icon
  // Reasoning and thinking blocks are expanded by default to show streaming content
  // Users can collapse them manually if desired
  const state = $activeSession.get();
  const list = state.messagesByModel[modelId] ?? [];
  $activeSession.set({
    ...state,
    messagesByModel: {
      ...state.messagesByModel,
      [modelId]: [...list, message],
    },
  });
  updateSessionTotals(session, state.statsByModel);
  persistSessionDebounced(session);
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
  const session = $activeSession.get().session;
  const settings = $settings.get();
  const uiState = $uiState.get();
  if (!session || settings.selectedModelIds.length === 0) return;
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
        session,
        modelId,
        role: input.role,
        contentText: input.text,
        imageIds,
      }),
    ),
  );
}

export async function sendMessageToAll(input: InputState, size = 512) {
  const session = $activeSession.get().session;
  const settings = $settings.get();
  const uiState = $uiState.get();
  if (!session || settings.selectedModelIds.length === 0) return;
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
  const multiplier = input.multiplier ?? 1;

  // Ensure system messages exist for each run BEFORE creating user messages
  // This ensures system messages appear first and have earlier timestamps
  await Promise.all(
    targetModelIds.flatMap((modelId) =>
      Array.from({ length: multiplier }, (_, index) =>
        ensureDefaultSystemMessage(session, modelId, index + 1),
      ),
    ),
  );

  // Duplicate user messages for each run - each run gets its own copy
  await Promise.all(
    targetModelIds.flatMap((modelId) =>
      Array.from({ length: multiplier }, (_, index) =>
        addMessageToModel({
          session,
          modelId,
          role: input.role,
          contentText: input.text,
          imageIds,
          runIndex: index + 1, // Each run gets its own copy
        }),
      ),
    ),
  );

  await Promise.all(
    targetModelIds.flatMap((modelId) =>
      Array.from({ length: multiplier }, (_, index) =>
        requestCompletionForModel(
          session,
          modelId,
          index + 1, // Always assign runIndex (1, 2, 3, etc.) for consistency
        ),
      ),
    ),
  );
}

async function requestCompletionForModel(
  session: Session,
  modelId: string,
  runIndex?: number,
) {
  const settings = $settings.get();
  if (!settings.apiKey) return;

  // Ensure system message exists for this run
  await ensureDefaultSystemMessage(session, modelId, runIndex);

  const requestMessages = await buildOpenRouterMessages(
    session.id,
    modelId,
    runIndex,
  );
  const assistantMessage = await addMessageToModel({
    session,
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
    const next = $activeSession.get();
    $activeSession.set({
      ...next,
      streamingByModel: { ...next.streamingByModel, [modelId]: true },
      errorsByModel: { ...next.errorsByModel, [modelId]: null },
    });
  }
  await ensureStatsForModel(session.id, modelId);
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
  const outputFormat = matchingDefault?.outputFormat; // May be undefined
  const outputFormatSet = matchingDefault?.outputFormatSet ?? false;
  const imageAspectRatio = matchingDefault?.imageAspectRatio;
  const imageAspectRatioSet = matchingDefault?.imageAspectRatioSet ?? false;
  const imageSize = matchingDefault?.imageSize;
  const imageSizeSet = matchingDefault?.imageSizeSet ?? false;

  // Build payload - exclude unsupported parameters for image-only models
  const payload: Record<string, unknown> = {
    model: modelId,
    messages: requestMessages,
    modalities,
    // Request usage data for cost tracking (OpenRouter format)
    usage: { include: true },
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
        `[Session] Excluding text generation parameters for image-only model: ${modelId}`,
      );
    }
  }

  // Add output_format - per-model override takes precedence over default
  const overrideOutputFormat = normalizedOverrides.output_format;
  if (overrideOutputFormat !== undefined) {
    payload.output_format = overrideOutputFormat;
  } else if (outputFormatSet && outputFormat) {
    payload.output_format = outputFormat;
  }

  // Add Gemini image generation hints only when image output is enabled.
  // OpenRouter currently documents image_config for Gemini image-gen models.
  const overrideImageConfig = normalizedOverrides.image_config;
  const isGeminiImageConfigModel =
    modelId.includes("google") && modalities.includes("image");
  if (overrideImageConfig && typeof overrideImageConfig === "object") {
    payload.image_config = overrideImageConfig;
  } else if (isGeminiImageConfigModel) {
    const imageConfig: Record<string, string> = {};
    if (imageAspectRatioSet && imageAspectRatio) {
      imageConfig.aspect_ratio = imageAspectRatio;
    }
    if (imageSizeSet && imageSize) {
      imageConfig.image_size = imageSize;
    }
    if (Object.keys(imageConfig).length > 0) {
      payload.image_config = imageConfig;
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
      key !== "output_format" &&
      key !== "image_config" &&
      value !== undefined
    ) {
      payload[key] = value;
    }
  });

  if (import.meta.env.DEV) {
    console.debug(
      `[Session] Request payload for ${modelId}:`,
      JSON.stringify(
        {
          model: payload.model,
          modalities: payload.modalities,
          messageCount: (payload.messages as OpenRouterMessage[]).length,
          reasoning: payload.reasoning,
          temperature: payload.temperature,
          max_tokens: payload.max_tokens,
          image_config: payload.image_config,
        },
        null,
        2,
      ),
    );
    if (isGeminiImageConfigModel) {
      console.debug(
        `[Session] Gemini Image config check for ${modelId}:`,
        {
          isGeminiImageConfigModel,
          imageAspectRatioSet,
          imageAspectRatio,
          imageSizeSet,
          imageSize,
          modalities,
        },
      );
    }
  }
  let usage: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number;
  } = {};
  let requestId: string | null = null;
  let sawOutput = false;
  let abortForFallback = false;
  let fallbackRan = false;
  let costFromStream = false;
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
    const current = $activeSession.get();
    const list = current.messagesByModel[modelId] ?? [];
    const messageIndex = list.findIndex(
      (msg) => msg.id === assistantMessage.id,
    );
    const updatedList =
      messageIndex >= 0
        ? list.map((msg, idx) => (idx === messageIndex ? messageCopy : msg))
        : [...list, messageCopy];
    $activeSession.set({
      ...current,
      messagesByModel: { ...current.messagesByModel, [modelId]: updatedList },
    });
    if (import.meta.env.DEV) {
      console.debug(
        `[Session] Updated message ${assistantMessage.id} for ${modelId} (runIndex: ${runIndex}):`,
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
    const current = $activeSession.get();
    const list = current.messagesByModel[modelId] ?? [];
    const updatedList = list.some((msg) => msg.id === assistantMessage.id)
      ? list.map((msg) =>
          msg.id === assistantMessage.id ? assistantMessage : msg,
        )
      : [...list, assistantMessage];
    const stats = current.statsByModel[modelId] ?? {
      sessionId: session.id,
      modelId,
      inputTokens: 0,
      outputTokens: 0,
      totalCost: 0,
    };

    const promptTokens = toNumber(usage.prompt_tokens) ?? 0;
    const completionTokens = toNumber(usage.completion_tokens) ?? 0;
    let calculatedCost = toNumber(usage.cost) ?? 0;

    if (!calculatedCost && (promptTokens || completionTokens)) {
      const models = $models.get();
      const modelInfo = models.find((m) => m.id === modelId);
      calculatedCost = calculateModelCostUsd({
        pricing: modelInfo?.pricing,
        promptTokens,
        completionTokens,
        outputImages: assistantMessage.imageIds.length,
      });
    }

    const nextStats: SessionStats = {
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
    const nextState: ActiveSessionState = {
      ...current,
      messagesByModel: { ...current.messagesByModel, [modelId]: updatedList },
      statsByModel: { ...current.statsByModel, [modelId]: nextStats },
      streamingByModel: {
        ...current.streamingByModel,
        [modelId]: stillStreaming,
      },
    };
    updateSessionTotals(session, nextState.statsByModel);
    if (!session.hasExecuted) {
      session.hasExecuted = true;
      session.firstExecutedAt = session.firstExecutedAt ?? Date.now();
    }
    $activeSession.set(nextState);
    if (!deletedSessionIds.has(session.id)) {
      await saveSession(session);
    }
    upsertHistorySession(session);
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
          cost: toNumber(result.usage.cost),
        };
        usage = {
          prompt_tokens: normalized.prompt_tokens ?? usage.prompt_tokens,
          completion_tokens:
            normalized.completion_tokens ?? usage.completion_tokens,
          cost: normalized.cost ?? usage.cost,
        };
        if (!usage.cost && (usage.prompt_tokens || usage.completion_tokens)) {
          const models = $models.get();
          const modelInfo = models.find((m) => m.id === modelId);
          usage.cost = calculateModelCostUsd({
            pricing: modelInfo?.pricing,
            promptTokens: usage.prompt_tokens ?? 0,
            completionTokens: usage.completion_tokens ?? 0,
            outputImages: assistantMessage.imageIds.length,
          });
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
          console.warn("[Session] No output detected:", {
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
      const current = $activeSession.get();
      // Check if any other runs are still streaming for this model
      const stillStreaming = Array.from(streamControllers.keys()).some((key) =>
        key.startsWith(`${modelId}-`),
      );
      $activeSession.set({
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
          console.debug(`[Session] Token received for ${modelId}:`, {
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
            `[Session] Reasoning token for ${modelId}:`,
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
            `[Session] Thinking token for ${modelId}:`,
            token.substring(0, 100),
          );
        }
        await applyAssistantUpdate();
      },
      onMessage: async (message) => {
        if (import.meta.env.DEV) {
          console.debug(`[Session] Message callback for ${modelId}:`, {
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
        const normalized = {
          prompt_tokens: toNumber(nextUsage.prompt_tokens),
          completion_tokens: toNumber(nextUsage.completion_tokens),
          cost: toNumber(nextUsage.cost),
        };
        const hasCost =
          "cost" in nextUsage &&
          nextUsage.cost !== undefined &&
          nextUsage.cost !== null;
        usage = {
          prompt_tokens: normalized.prompt_tokens ?? usage.prompt_tokens,
          completion_tokens:
            normalized.completion_tokens ?? usage.completion_tokens,
          cost: hasCost ? normalized.cost : usage.cost,
        };
        if (hasCost) {
          costFromStream = true;
        }
      },
      onRequestId: (id: string) => {
        requestId = id;
        if (import.meta.env.DEV) {
          console.debug(`[Session] Received request ID for ${modelId}:`, id);
        }
      },
      onError: async (error) => {
        if (import.meta.env.DEV) {
          console.error(`[Session] Stream error for ${modelId}:`, error);
        }
        if (abortForFallback) return;
        assistantMessage.status = "error";
        assistantMessage.completedAt = Date.now();
        assistantMessage.error = error.message;
        assistantMessage.updatedAt = Date.now();
        await applyAssistantUpdate();
        const current = $activeSession.get();
        $activeSession.set({
          ...current,
          errorsByModel: { ...current.errorsByModel, [modelId]: error.message },
        });
      },
      onDone: async () => {
        window.clearTimeout(fallbackTimeout);
        if (import.meta.env.DEV) {
          console.debug(`[Session] Stream done for ${modelId}`, {
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
            `[Session] Stored ${storedIds.length} image(s) for ${modelId}`,
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

        // If cost is still missing and we have a request ID, query the generation endpoint
        if (
          !usage.cost &&
          requestId &&
          settings.apiKey &&
          (usage.prompt_tokens || usage.completion_tokens)
        ) {
          if (import.meta.env.DEV) {
            console.debug(
              `[Session] Querying generation endpoint for ${modelId} (request ID: ${requestId})`,
            );
          }
          try {
            const generationUsage = await fetchGenerationCost(
              settings.apiKey,
              requestId,
            );
            if (generationUsage?.cost !== undefined) {
              usage.cost = generationUsage.cost;
              if (import.meta.env.DEV) {
                console.debug(
                  `[Session] ✓ Retrieved cost ($${generationUsage.cost}) from generation endpoint for ${modelId}`,
                );
              }
            }
          } catch (error) {
            if (import.meta.env.DEV) {
              console.warn(
                `[Session] Failed to query generation endpoint for ${modelId}:`,
                error,
              );
            }
          }
        }

        // Verify cost estimation against OpenRouter's post-stream usage report
        // Only verify if cost came from stream (not fetched from generation endpoint)
        if (
          requestId &&
          settings.apiKey &&
          costFromStream &&
          usage.cost !== undefined &&
          usage.cost !== null &&
          (usage.prompt_tokens || usage.completion_tokens)
        ) {
          try {
            const generationUsage = await fetchGenerationCost(
              settings.apiKey,
              requestId,
              true, // Enable retry on 404
            );
            if (generationUsage?.cost !== undefined) {
              const streamCost = usage.cost;
              const verifiedCost = generationUsage.cost;
              const costDifference = Math.abs(streamCost - verifiedCost);
              const tolerance = 0.000001; // Allow tiny floating point differences

              if (costDifference > tolerance) {
                // Costs don't match - show error
                const models = $models.get();
                const modelInfo = models.find((m) => m.id === modelId);
                const modelName = modelInfo?.name ?? modelId;
                showVerificationDialog({
                  type: "error",
                  title: "Cost Verification Failed",
                  message: `Cost estimation mismatch for ${modelName}:\n\nStream cost: $${streamCost.toFixed(6)}\nVerified cost: $${verifiedCost.toFixed(6)}\nDifference: $${costDifference.toFixed(6)}\n\nPlease verify against OpenRouter dashboard.`,
                  modelId,
                });
              } else {
                // Costs match - show success
                const models = $models.get();
                const modelInfo = models.find((m) => m.id === modelId);
                const modelName = modelInfo?.name ?? modelId;
                showVerificationDialog({
                  type: "success",
                  title: "Cost Verification Successful",
                  message: `Cost estimation for ${modelName} verified against OpenRouter's post-stream usage report.\n\nCost: $${verifiedCost.toFixed(6)}`,
                  modelId,
                });
              }
            }
          } catch (error) {
            if (import.meta.env.DEV) {
              console.warn(
                `[Session] Failed to verify cost from generation endpoint for ${modelId}:`,
                error,
              );
            }
          }
        }

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
          console.debug(`[Session] Stream done check for ${modelId}:`, {
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
              `[Session] Stream completed with no output for ${modelId}:`,
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
    const current = $activeSession.get();
    $activeSession.set({
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
      const state = $activeSession.get();
      // Check if any other runs are still streaming for this model
      const stillStreaming = Array.from(streamControllers.keys()).some((key) =>
        key.startsWith(`${modelId}-`),
      );
      $activeSession.set({
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
    const state = $activeSession.get();
    $activeSession.set({
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
  const session = $activeSession.get().session;
  if (!session) return;

  // Each run has its own copies of messages, so delete messages for the specified run
  // If runIndex is not specified, delete for all runs (legacy support)
  await deleteMessagesAfter(session.id, modelId, messageId, runIndex);

  const remaining = await getMessages(session.id, modelId);
  const state = $activeSession.get();
  $activeSession.set({
    ...state,
    messagesByModel: { ...state.messagesByModel, [modelId]: remaining },
  });
  updateSessionTotals(session, state.statsByModel);
  await saveSession(session);
}

export async function rerunLastAssistantMessage(modelId: string) {
  const state = $activeSession.get();
  const session = state.session;
  if (!session) return;

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
    await deleteMessagesAfter(session.id, modelId, lastAssistantMessage.id);
  }

  // Reload messages and re-run completion
  const updatedMessages = await getMessages(session.id, modelId);
  $activeSession.set({
    ...state,
    messagesByModel: { ...state.messagesByModel, [modelId]: updatedMessages },
  });

  // Re-run the completion
  await requestCompletionForModel(session, modelId);
}

export async function ensureSessionLoaded() {
  if (!$activeSessionId.get()) {
    await initializeSession();
    return;
  }
  const session = await getSession($activeSessionId.get()!);
  if (!session) {
    await initializeSession();
  } else {
    await loadSession(session.id);
  }
}

export async function updateSessionTitle(
  title: string | undefined,
  sessionId?: string,
) {
  const targetId = sessionId;
  if (targetId) {
    // Update a specific session by ID
    const session = await getSession(targetId);
    if (!session) return;
    const updatedSession = {
      ...session,
      title: title?.trim() || undefined,
    };
    await saveSession(updatedSession);
    upsertHistorySession(updatedSession);
    // Update active session if it matches
    const state = $activeSession.get();
    if (state.session?.id === targetId) {
      $activeSession.set({
        ...state,
        session: updatedSession,
      });
    }
    return;
  }

  // Update active session (original behavior)
  const state = $activeSession.get();
  const session = state.session;
  if (!session) return;
  const updatedSession = {
    ...session,
    title: title?.trim() || undefined,
  };
  $activeSession.set({
    ...state,
    session: updatedSession,
  });
  // Always persist title changes, even if session hasn't executed yet
  if (!deletedSessionIds.has(updatedSession.id)) {
    await saveSession(updatedSession);
  }
  upsertHistorySession(updatedSession);
}

export async function syncSessionModels(modelIds: string[]) {
  const state = $activeSession.get();
  const session = state.session;
  if (!session) return;
  const updatedSession = { ...session, modelIds };
  const messagesByModel: Record<string, Message[]> = {};
  const statsByModel: Record<string, SessionStats> = {};
  const missingStats: SessionStats[] = [];
  for (const modelId of modelIds) {
    messagesByModel[modelId] = state.messagesByModel[modelId] ?? [];
    if (state.statsByModel[modelId]) {
      statsByModel[modelId] = state.statsByModel[modelId];
      continue;
    }
    const stat: SessionStats = {
      sessionId: updatedSession.id,
      modelId,
      inputTokens: 0,
      outputTokens: 0,
      totalCost: 0,
    };
    statsByModel[modelId] = stat;
    missingStats.push(stat);
  }
  if (updatedSession.hasExecuted && missingStats.length) {
    await Promise.all(missingStats.map((stat) => saveStats(stat)));
  }
  $activeSession.set({
    ...state,
    session: updatedSession,
    messagesByModel,
    statsByModel,
  });
  if (updatedSession.hasExecuted && !deletedSessionIds.has(updatedSession.id)) {
    await saveSession(updatedSession);
  }
  upsertHistorySession(updatedSession);

  // System messages will be created when runs start, not during sync
}
