import type {
  OpenRouterCompletionRequest,
  OpenRouterModelsResponse,
} from "../types/openrouter";

const API_BASE = "https://openrouter.ai/api/v1";

type OpenRouterUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  cost?: number;
};

export type OpenRouterAttachment = {
  name?: string;
  url?: string;
  mimeType?: string;
  dataBase64?: string;
};

type OpenRouterContent = { text: string; imageUrls: string[] };
type OpenRouterReasoning = { reasoning: string; thinking: string };

export type OpenRouterImageDebug = Record<
  string,
  { chunks: number[]; locations: string[] }
>;

export type OpenRouterAttachmentDebug = Record<
  string,
  { chunks: number[]; locations: string[] }
>;

async function fetchWithRetry(
  input: RequestInfo,
  init: RequestInit,
  retries = 1,
) {
  let attempt = 0;
  while (attempt <= retries) {
    const response = await fetch(input, init);
    if (response.ok) return response;
    if (response.status >= 500 || response.status === 429) {
      attempt += 1;
      if (attempt > retries) return response;
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
      continue;
    }
    return response;
  }
  throw new Error("Unexpected fetch retry failure");
}

export async function fetchOpenRouterModels(
  apiKey: string,
): Promise<OpenRouterModelsResponse> {
  const response = await fetchWithRetry(`${API_BASE}/models`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });
  if (!response.ok) {
    throw new Error(`OpenRouter models error: ${response.status}`);
  }
  return (await response.json()) as OpenRouterModelsResponse;
}

export async function fetchGenerationCost(
  apiKey: string,
  generationId: string,
  retryOn404 = true,
): Promise<{
  cost?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
} | null> {
  try {
    // Generation endpoint may not be immediately available after stream completes
    // Wait a second first, then retry on 404s
    if (retryOn404) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    const maxRetries = retryOn404 ? 3 : 0;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        // Exponential backoff: 1s, 2s, 4s
        const delay = 1000 * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      const response = await fetch(
        `${API_BASE}/generation?id=${generationId}`,
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
        },
      );

      if (response.ok) {
        const data = (await response.json()) as {
          data?: Array<{
            usage?: {
              prompt_tokens?: number;
              completion_tokens?: number;
              cost?: number;
            };
          }>;
        };
        const generation = data.data?.[0];
        return generation?.usage ?? null;
      }

      // If 404 and we have retries left, continue
      if (response.status === 404 && attempt < maxRetries) {
        if (import.meta.env.DEV) {
          console.debug(
            `[OpenRouter] Generation endpoint 404 (attempt ${attempt + 1}/${maxRetries + 1}), retrying...`,
          );
        }
        continue;
      }

      return null;
    }

    return null;
  } catch (error) {
    if (import.meta.env.DEV) {
      console.warn(`[OpenRouter] Failed to fetch generation cost:`, error);
    }
    return null;
  }
}

export async function streamCompletion({
  apiKey,
  payload,
  onToken,
  onReasoningToken,
  onThinkingToken,
  onError,
  onDone,
  onUsage,
  onMessage,
  signal,
  onRequestId,
}: {
  apiKey: string;
  payload: OpenRouterCompletionRequest;
  onToken: (token: string) => void;
  onReasoningToken?: (token: string) => void;
  onThinkingToken?: (token: string) => void;
  onError: (error: Error) => void;
  onDone: () => void;
  onUsage?: (usage: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number;
  }) => void;
  onMessage?: (message: {
    text: string;
    imageUrls: string[];
    attachments?: OpenRouterAttachment[];
    debug?: {
      images: OpenRouterImageDebug;
      attachments: OpenRouterAttachmentDebug;
    };
  }) => void;
  onRequestId?: (id: string) => void;
  signal?: AbortSignal;
}): Promise<void> {
  const response = await fetchWithRetry(`${API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ...payload, stream: true }),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    const error = new Error(
      `OpenRouter stream error: ${response.status}${errorText ? ` - ${errorText}` : ""}`,
    );
    if (import.meta.env.DEV) {
      console.error("[OpenRouter] Stream error:", error);
    }
    throw error;
  }
  if (!response.body) {
    const error = new Error("OpenRouter stream error: No response body");
    if (import.meta.env.DEV) {
      console.error("[OpenRouter]", error);
    }
    throw error;
  }

  const contentType = response.headers.get("content-type") ?? "";
  const isEventStream = contentType.includes("text/event-stream");
  if (!isEventStream) {
    const json = (await response.json()) as {
      choices?: Array<{
        message?: { content?: unknown; images?: unknown[] };
        images?: unknown[];
      }>;
      usage?: OpenRouterUsage;
      reasoning?: unknown;
      attachments?: unknown;
    };
    const choice = json.choices?.[0];
    const message = choice?.message;

    // Extract images from message.content (content array with image_url parts)
    const messageContent = message?.content;
    const { text, imageUrls: contentImageUrls } =
      extractContent(messageContent);

    // Extract images from message.images array if present
    const messageImages = Array.isArray(message?.images)
      ? message.images
          .map((img: unknown) => {
            if (img && typeof img === "object") {
              const imgObj = img as Record<string, unknown>;
              const url =
                (imgObj.image_url as { url?: string })?.url ||
                (imgObj.url as string);
              return typeof url === "string" ? url : null;
            }
            return null;
          })
          .filter((url): url is string => url !== null)
      : [];

    // Extract images from choice.images (if present at choice level)
    const choiceImages = Array.isArray(choice?.images)
      ? choice.images
          .map((img: unknown) => {
            if (img && typeof img === "object") {
              const imgObj = img as Record<string, unknown>;
              const url =
                (imgObj.image_url as { url?: string })?.url ||
                (imgObj.url as string);
              return typeof url === "string" ? url : null;
            }
            return null;
          })
          .filter((url): url is string => url !== null)
      : [];

    // Combine all image sources
    const allImageUrls = [
      ...contentImageUrls,
      ...messageImages,
      ...choiceImages,
    ];

    if (text) onToken(text);
    const attachments = dedupeAttachments(extractAttachments(json));
    const uniqueImageUrls = uniqueStrings(allImageUrls);
    // Always call onMessage if we have any content (text, images, or attachments)
    if (text || uniqueImageUrls.length || attachments.length) {
      onMessage?.({
        text,
        imageUrls: uniqueImageUrls,
        attachments,
        debug: {
          images: buildDebugForNonStreaming(uniqueImageUrls),
          attachments: buildDebugForNonStreamingAttachments(attachments),
        },
      });
    }
    if (json.usage) onUsage?.(json.usage);
    const r = extractReasoning(json);
    if (r.reasoning) onReasoningToken?.(r.reasoning);
    if (r.thinking) onThinkingToken?.(r.thinking);
    onDone();
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  // Track if we've seen delta content/reasoning/thinking to avoid duplicating final message content
  let hasSeenDeltaContent = false;
  let hasSeenDeltaReasoning = false;
  let hasSeenDeltaThinking = false;
  // Track when content types start for logging
  let hasStartedText = false;
  let hasStartedReasoning = false;
  let hasStartedImages = false;
  let chunkId = 0;
  const collectedImageUrls = new Set<string>();
  const imageDebug: OpenRouterImageDebug = {};
  const collectedAttachments: OpenRouterAttachment[] = [];
  const attachmentDebug: OpenRouterAttachmentDebug = {};
  const attachmentKeys = new Set<string>();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      // Skip empty lines and comment lines (OpenRouter may send comments starting with :)
      if (!trimmed || trimmed.startsWith(":")) continue;
      // Only process data: lines
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.replace(/^data:\s*/, "");
      if (data === "[DONE]") {
        if (import.meta.env.DEV) {
          console.log(`[OpenRouter] [DONE] received (chunk ${chunkId})`);
        }
        if (collectedImageUrls.size > 0 || collectedAttachments.length > 0) {
          onMessage?.({
            text: "",
            imageUrls: Array.from(collectedImageUrls),
            attachments: collectedAttachments,
            debug: { images: imageDebug, attachments: attachmentDebug },
          });
        }
        onDone();
        return;
      }
      // Skip empty data lines
      if (!data) continue;
      chunkId++;
      try {
        const parsed = JSON.parse(data) as {
          id?: string; // Request ID for querying generation endpoint
          choices?: Array<{
            delta?: {
              content?: unknown;
              reasoning?: string;
              thinking?: string;
              images?: unknown[];
            };
            message?: {
              content?: unknown;
              images?: unknown[];
              reasoning?: string;
              thinking?: string;
            };
            images?: unknown[];
            reasoning?: string;
            thinking?: string;
            attachments?: unknown;
          }>;
          usage?: OpenRouterUsage;
          reasoning?: unknown;
          thinking?: unknown;
          attachments?: unknown;
        };

        const attachments = dedupeAttachments(extractAttachments(parsed));
        if (attachments.length > 0) {
          for (const attachment of attachments) {
            const key = attachmentKey(attachment);
            if (attachmentKeys.has(key)) continue;
            attachmentKeys.add(key);
            collectedAttachments.push(attachment);
            mergeDebugEntry(attachmentDebug, key, chunkId, "attachments");
          }
        }
        const choice = parsed.choices?.[0];
        const delta = choice?.delta;

        // Handle delta content (streaming chunks) - incremental tokens
        const deltaContent = delta?.content;
        if (deltaContent !== undefined && deltaContent !== null) {
          hasSeenDeltaContent = true;
          if (!hasStartedText) {
            hasStartedText = true;
            if (import.meta.env.DEV) {
              console.log(
                `[OpenRouter] Text response started (chunk ${chunkId})`,
              );
            }
          }
          if (typeof deltaContent === "string") {
            onToken(deltaContent);
          } else {
            // Non-standard: try to extract text from complex delta
            const extracted = extractContent(deltaContent);
            if (extracted.text) {
              onToken(extracted.text);
            }
            if (extracted.imageUrls.length > 0) {
              for (const url of uniqueStrings(extracted.imageUrls)) {
                if (!url) continue;
                if (collectedImageUrls.has(url)) continue;
                collectedImageUrls.add(url);
                mergeDebugEntry(imageDebug, url, chunkId, "delta.content");
              }
            }
          }
        }

        // Extract images from ALL possible locations in EVERY chunk
        // This ensures we catch images regardless of which chunk they arrive in
        const allImageUrls: string[] = [];

        // 1. Check delta.images (incremental streaming images)
        const deltaImages = Array.isArray(delta?.images) ? delta.images : [];
        if (deltaImages.length) {
          const urls = deltaImages
            .map((img: unknown) => {
              if (img && typeof img === "object") {
                const imgObj = img as Record<string, unknown>;
                return (
                  (imgObj.image_url as { url?: string })?.url ||
                  (imgObj.url as string) ||
                  null
                );
              }
              return null;
            })
            .filter((u): u is string => typeof u === "string" && u.length > 0);
          allImageUrls.push(...urls);
        }

        // 2. Check choice.images (choice-level images, may appear in any chunk)
        const choiceImages = Array.isArray(choice?.images)
          ? choice.images
              .map((img: unknown) => {
                if (img && typeof img === "object") {
                  const imgObj = img as Record<string, unknown>;
                  const url =
                    (imgObj.image_url as { url?: string })?.url ||
                    (imgObj.url as string);
                  return typeof url === "string" ? url : null;
                }
                return null;
              })
              .filter((url): url is string => url !== null)
          : [];
        if (choiceImages.length > 0) {
          allImageUrls.push(...choiceImages);
        }

        // 3. Check message.images (message-level images)
        const message = choice?.message;
        const messageImages = Array.isArray(message?.images)
          ? message.images
              .map((img: unknown) => {
                if (img && typeof img === "object") {
                  const imgObj = img as Record<string, unknown>;
                  const url =
                    (imgObj.image_url as { url?: string })?.url ||
                    (imgObj.url as string);
                  return typeof url === "string" ? url : null;
                }
                return null;
              })
              .filter((url): url is string => url !== null)
          : [];
        if (messageImages.length > 0) {
          allImageUrls.push(...messageImages);
        }

        // 4. Check message.content for images (content array with image_url parts)
        if (message?.content !== undefined && message.content !== null) {
          const extracted = extractContent(message.content);
          if (extracted.imageUrls.length > 0) {
            allImageUrls.push(...extracted.imageUrls);
          }
          // Only emit text if we haven't seen delta content (non-streaming fallback)
          if (extracted.text && !hasSeenDeltaContent) {
            if (!hasStartedText) {
              hasStartedText = true;
              if (import.meta.env.DEV) {
                console.log(
                  `[OpenRouter] Text response started (chunk ${chunkId})`,
                );
              }
            }
            onToken(extracted.text);
          }
        }

        const uniqueImageUrls = uniqueStrings(allImageUrls);
        if (uniqueImageUrls.length > 0) {
          let addedCount = 0;
          for (const url of uniqueImageUrls) {
            if (!url) continue;
            if (collectedImageUrls.has(url)) continue;
            collectedImageUrls.add(url);
            mergeDebugEntry(imageDebug, url, chunkId, "chunk.images");
            addedCount++;
          }
          if (addedCount > 0 && !hasStartedImages) {
            hasStartedImages = true;
            if (import.meta.env.DEV) {
              console.log(
                `[OpenRouter] Image(s) started arriving (chunk ${chunkId})`,
              );
            }
          }
        }

        // Extract reasoning/thinking from delta (streaming chunks) - incremental tokens
        const deltaReasoning =
          typeof delta?.reasoning === "string" ? delta.reasoning : undefined;
        const deltaThinking =
          typeof delta?.thinking === "string" ? delta.thinking : undefined;

        // Track if we've seen delta reasoning/thinking to avoid duplicating final message
        if (deltaReasoning) {
          hasSeenDeltaReasoning = true;
        }
        if (deltaThinking) {
          hasSeenDeltaThinking = true;
        }

        // Extract reasoning/thinking from choice level
        const choiceReasoning =
          typeof choice?.reasoning === "string" ? choice.reasoning : undefined;
        const choiceThinking =
          typeof choice?.thinking === "string" ? choice.thinking : undefined;

        // Extract reasoning/thinking from message level (final message)
        // Only use if we haven't seen delta tokens (to avoid duplication)
        const messageReasoning =
          !hasSeenDeltaReasoning && typeof message?.reasoning === "string"
            ? message.reasoning
            : undefined;
        const messageThinking =
          !hasSeenDeltaThinking && typeof message?.thinking === "string"
            ? message.thinking
            : undefined;

        // Emit reasoning tokens (prioritize delta > choice > message)
        // Delta tokens are incremental, choice/message are cumulative
        const reasoningToken =
          deltaReasoning ?? choiceReasoning ?? messageReasoning;
        const thinkingToken =
          deltaThinking ?? choiceThinking ?? messageThinking;

        if (reasoningToken || thinkingToken) {
          if (!hasStartedReasoning) {
            hasStartedReasoning = true;
            if (import.meta.env.DEV) {
              console.log(`[OpenRouter] Reasoning started (chunk ${chunkId})`);
            }
          }
          if (reasoningToken) {
            onReasoningToken?.(reasoningToken);
          }
          if (thinkingToken) {
            onThinkingToken?.(thinkingToken);
          }
        }

        // Also check root-level reasoning/thinking (for non-standard formats)
        const r = extractReasoning(parsed);
        if (r.reasoning && !reasoningToken) {
          if (!hasStartedReasoning) {
            hasStartedReasoning = true;
            if (import.meta.env.DEV) {
              console.log(`[OpenRouter] Reasoning started (chunk ${chunkId})`);
            }
          }
          onReasoningToken?.(r.reasoning);
        }
        if (r.thinking && !thinkingToken) {
          if (!hasStartedReasoning) {
            hasStartedReasoning = true;
            if (import.meta.env.DEV) {
              console.log(`[OpenRouter] Reasoning started (chunk ${chunkId})`);
            }
          }
          onThinkingToken?.(r.thinking);
        }

        // Capture request ID if provided (for querying generation endpoint later)
        if (parsed.id && onRequestId) {
          onRequestId(parsed.id);
        }

        // Process usage AFTER images to ensure images are emitted first
        // This ensures that even if usage appears in the same chunk as images,
        // images are processed and emitted before usage
        if (parsed.usage) {
          onUsage?.(parsed.usage);
        }
      } catch (error) {
        onError(error as Error);
      }
    }
  }
  if (collectedImageUrls.size > 0 || collectedAttachments.length > 0) {
    onMessage?.({
      text: "",
      imageUrls: Array.from(collectedImageUrls),
      attachments: collectedAttachments,
      debug: { images: imageDebug, attachments: attachmentDebug },
    });
  }
  onDone();
}

export async function requestCompletion({
  apiKey,
  payload,
  signal,
}: {
  apiKey: string;
  payload: OpenRouterCompletionRequest;
  signal?: AbortSignal;
}): Promise<string> {
  const result = await requestCompletionFull({ apiKey, payload, signal });
  return result.content.text;
}

export async function requestCompletionFull({
  apiKey,
  payload,
  signal,
}: {
  apiKey: string;
  payload: OpenRouterCompletionRequest;
  signal?: AbortSignal;
}): Promise<{
  content: OpenRouterContent;
  usage?: OpenRouterUsage;
  reasoning?: OpenRouterReasoning;
  attachments?: OpenRouterAttachment[];
}> {
  const response = await fetchWithRetry(`${API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ...payload, stream: false }),
    signal,
  });
  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(
      `OpenRouter completion error: ${response.status}${errorText ? ` - ${errorText}` : ""}`,
    );
  }
  const data = (await response.json()) as {
    choices?: Array<{
      message?: { content?: unknown; images?: unknown[] };
      images?: unknown[];
    }>;
    usage?: OpenRouterUsage;
    reasoning?: unknown;
    attachments?: unknown;
  };
  if (import.meta.env.DEV) {
    console.debug(
      "[OpenRouter] Completion response (full):",
      JSON.stringify(data, null, 2).substring(0, 1000),
    );
  }

  const choice = data.choices?.[0];
  const message = choice?.message;

  // Extract images from message.content (content array with image_url parts)
  const content = extractContent(message?.content);

  // Extract images from message.images array if present
  const messageImages = Array.isArray(message?.images)
    ? message.images
        .map((img: unknown) => {
          if (img && typeof img === "object") {
            const imgObj = img as Record<string, unknown>;
            const url =
              (imgObj.image_url as { url?: string })?.url ||
              (imgObj.url as string);
            return typeof url === "string" ? url : null;
          }
          return null;
        })
        .filter((url): url is string => url !== null)
    : [];

  // Extract images from choice.images (if present at choice level)
  const choiceImages = Array.isArray(choice?.images)
    ? choice.images
        .map((img: unknown) => {
          if (img && typeof img === "object") {
            const imgObj = img as Record<string, unknown>;
            const url =
              (imgObj.image_url as { url?: string })?.url ||
              (imgObj.url as string);
            return typeof url === "string" ? url : null;
          }
          return null;
        })
        .filter((url): url is string => url !== null)
    : [];

  // Combine all image sources
  const allImageUrls = [
    ...content.imageUrls,
    ...messageImages,
    ...choiceImages,
  ];

  if (import.meta.env.DEV) {
    console.debug("[OpenRouter] Non-streaming response details:", {
      hasText: content.text.length > 0,
      textLength: content.text.length,
      textPreview: content.text.substring(0, 100),
      messageImagesCount: messageImages.length,
      messageImages: messageImages,
      choiceImagesCount: choiceImages.length,
      choiceImages: choiceImages,
      contentImageUrlsCount: content.imageUrls.length,
      totalImageUrlsCount: allImageUrls.length,
      rawMessageImages: message?.images,
      rawChoiceImages: choice?.images,
      messageContentType: typeof message?.content,
    });
  }

  return {
    content: {
      text: content.text,
      imageUrls: uniqueStrings(allImageUrls),
    },
    usage: data.usage,
    reasoning: extractReasoning(data),
    attachments: dedupeAttachments(extractAttachments(data)),
  };
}

function uniqueStrings(items: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!item) continue;
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function attachmentKey(attachment: OpenRouterAttachment): string {
  if (attachment.url) return `url:${attachment.url}`;
  if (attachment.dataBase64) return `data:${attachment.dataBase64}`;
  return `name:${attachment.name ?? ""}|mime:${attachment.mimeType ?? ""}`;
}

function dedupeAttachments(
  attachments: OpenRouterAttachment[],
): OpenRouterAttachment[] {
  const out: OpenRouterAttachment[] = [];
  const seen = new Set<string>();
  for (const attachment of attachments) {
    const key = attachmentKey(attachment);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(attachment);
  }
  return out;
}

function mergeDebugEntry(
  debug: Record<string, { chunks: number[]; locations: string[] }>,
  key: string,
  chunkId: number,
  location: string,
) {
  const entry = debug[key] ?? { chunks: [], locations: [] };
  if (!entry.chunks.includes(chunkId)) entry.chunks.push(chunkId);
  if (!entry.locations.includes(location)) entry.locations.push(location);
  debug[key] = entry;
}

function buildDebugForNonStreaming(urls: string[]): OpenRouterImageDebug {
  const debug: OpenRouterImageDebug = {};
  urls.forEach((url) => {
    debug[url] = { chunks: [], locations: ["non-streaming"] };
  });
  return debug;
}

function buildDebugForNonStreamingAttachments(
  attachments: OpenRouterAttachment[],
): OpenRouterAttachmentDebug {
  const debug: OpenRouterAttachmentDebug = {};
  attachments.forEach((a) => {
    debug[attachmentKey(a)] = { chunks: [], locations: ["non-streaming"] };
  });
  return debug;
}

function extractContent(content: unknown): OpenRouterContent {
  // Standard OpenRouter format: content is usually a string or array
  if (typeof content === "string") {
    return { text: content, imageUrls: [] };
  }

  if (Array.isArray(content)) {
    // Content array with parts: [{type: "text", text: "..."}, {type: "image_url", image_url: {url: "..."}}]
    const textParts: string[] = [];
    const imageUrls: string[] = [];

    for (const part of content) {
      if (!part || typeof part !== "object") continue;
      const type = (part as { type?: string }).type;

      if (type === "text") {
        const text = (part as { text?: string }).text;
        if (text !== undefined && text !== null) {
          textParts.push(String(text));
        }
      } else if (type === "image_url") {
        const url = (part as { image_url?: { url?: string } }).image_url?.url;
        if (url) imageUrls.push(url);
      }
    }

    return { text: textParts.join("\n"), imageUrls };
  }

  // Fallback for non-standard formats
  if (content && typeof content === "object") {
    const asObject = content as Record<string, unknown>;
    if (typeof asObject.text === "string") {
      return { text: asObject.text, imageUrls: [] };
    }
  }

  return { text: "", imageUrls: [] };
}

function extractReasoning(payload: unknown): OpenRouterReasoning {
  if (!payload || typeof payload !== "object")
    return { reasoning: "", thinking: "" };
  const root = payload as Record<string, unknown>;

  // Check for reasoning_details array format (some models use this)
  const reasoningDetails = root.reasoning_details;
  let detailsReasoning = "";
  let detailsThinking = "";
  if (Array.isArray(reasoningDetails)) {
    for (const detail of reasoningDetails) {
      if (detail && typeof detail === "object") {
        const detailObj = detail as Record<string, unknown>;
        const format = detailObj.format;
        const content = detailObj.content || detailObj.text;
        if (typeof content === "string") {
          if (format === "thinking" || format === "thought") {
            detailsThinking += content;
          } else {
            detailsReasoning += content;
          }
        }
      }
    }
  }

  // Check for direct reasoning/thinking fields
  const directReasoning =
    typeof root.reasoning === "string" ? (root.reasoning as string) : "";
  const directThinking =
    typeof root.thinking === "string" ? (root.thinking as string) : "";

  // Check choices array
  const choices = root.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0] as Record<string, unknown>;

    // Check message.reasoning_details
    const message = first.message;
    if (message && typeof message === "object") {
      const msgObj = message as Record<string, unknown>;
      const msgReasoningDetails = msgObj.reasoning_details;
      if (Array.isArray(msgReasoningDetails)) {
        for (const detail of msgReasoningDetails) {
          if (detail && typeof detail === "object") {
            const detailObj = detail as Record<string, unknown>;
            const format = detailObj.format;
            const content = detailObj.content || detailObj.text;
            if (typeof content === "string") {
              if (format === "thinking" || format === "thought") {
                detailsThinking += content;
              } else {
                detailsReasoning += content;
              }
            }
          }
        }
      }
    }

    const choiceReasoning =
      typeof first.reasoning === "string" ? (first.reasoning as string) : "";
    const choiceThinking =
      typeof first.thinking === "string" ? (first.thinking as string) : "";

    return {
      reasoning: choiceReasoning || detailsReasoning || directReasoning,
      thinking: choiceThinking || detailsThinking || directThinking,
    };
  }
  return {
    reasoning: detailsReasoning || directReasoning,
    thinking: detailsThinking || directThinking,
  };
}

function extractAttachments(payload: unknown): OpenRouterAttachment[] {
  if (!payload || typeof payload !== "object") return [];
  const root = payload as Record<string, unknown>;
  const candidates: unknown[] = [];

  if (Array.isArray(root.attachments)) {
    candidates.push(...(root.attachments as unknown[]));
  }

  const choices = root.choices;
  if (Array.isArray(choices) && choices.length > 0) {
    const first = choices[0] as Record<string, unknown>;
    if (Array.isArray(first.attachments)) {
      candidates.push(...(first.attachments as unknown[]));
    }
    const message = first.message;
    if (message && typeof message === "object") {
      const attachments = (message as Record<string, unknown>).attachments;
      if (Array.isArray(attachments)) {
        candidates.push(...(attachments as unknown[]));
      }
    }
  }

  const attachments: OpenRouterAttachment[] = [];
  for (const item of candidates) {
    if (!item || typeof item !== "object") continue;
    const obj = item as Record<string, unknown>;
    const name = typeof obj.name === "string" ? obj.name : undefined;
    const url = typeof obj.url === "string" ? obj.url : undefined;
    const mimeType =
      typeof obj.mimeType === "string"
        ? (obj.mimeType as string)
        : typeof obj.mime_type === "string"
          ? (obj.mime_type as string)
          : undefined;
    const dataBase64 =
      typeof obj.data === "string"
        ? (obj.data as string)
        : typeof obj.content === "string"
          ? (obj.content as string)
          : undefined;
    if (name || url || dataBase64) {
      attachments.push({ name, url, mimeType, dataBase64 });
    }
  }
  return attachments;
}
