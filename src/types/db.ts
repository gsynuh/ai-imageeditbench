export type ViewKey = "session" | "models" | "stats" | "defaults" | "history";

export type MessageRole = "system" | "user" | "assistant" | "tool";

export type MessageStatus = "complete" | "streaming" | "error" | "aborted";

export interface ImageAsset {
  id: string;
  blob: Blob;
  mimeType: string;
  width: number;
  height: number;
  bytes?: number;
  createdAt: number;
}

export interface Message {
  id: string;
  sessionId: string;
  modelId: string;
  role: MessageRole;
  contentText: string;
  contentReasoning?: string;
  contentThinking?: string;
  imageIds: string[];
  createdAt: number;
  updatedAt: number;
  firstTokenAt?: number;
  completedAt?: number;
  status: MessageStatus;
  error?: string;
  runIndex?: number; // 1-based run index when multiplier > 1
}

export interface Session {
  id: string;
  createdAt: number;
  updatedAt: number;
  modelIds: string[];
  title?: string;
  hasExecuted: boolean;
  firstExecutedAt?: number;
  messageCount: number;
  totalTokens: number;
  totalCost: number;
}

export interface SessionStats {
  sessionId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  totalCost: number;
}

export type ModelParameterValue = string | number | boolean;

export interface SettingsState {
  id: "settings";
  apiKey: string;
  selectedModelIds: string[];
  perModelParameters: Record<string, Record<string, ModelParameterValue>>;
  modelParamSchema: Record<string, Record<string, ModelParamSpec>>;
  storeVersion?: number;
}

export interface ModelParamSpec {
  label: string;
  type: "number" | "string" | "boolean" | "enum";
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
}

export interface DefaultEntry {
  id: string;
  name: string;
  modelFilter: string; // Regex pattern for model ID matching
  systemMessage?: string; // Default system message to prepend (only sent if set)
  systemMessageSet: boolean; // Whether system message is set
  streamReasoning: boolean; // Whether to stream reasoning tokens (only sent if set)
  streamReasoningSet: boolean; // Whether stream reasoning is set
  reasoningEffort?: "low" | "medium" | "high"; // Reasoning effort level (only sent if set)
  reasoningEffortSet: boolean; // Whether reasoning effort is set
  temperature?: number; // Temperature (0 to 1.5) (only sent if set)
  temperatureSet: boolean; // Whether temperature is set
  keepOnlyLastImage: boolean; // Whether to keep only the last received image
  keepOnlyLastImageSet: boolean; // Whether keepOnlyLastImage is set
  outputFormat?: "png" | "jpeg" | "webp"; // Image output format (only sent if set)
  outputFormatSet: boolean; // Whether output format is set
  createdAt: number;
  updatedAt: number;
}

export interface DefaultsState {
  entries: DefaultEntry[];
  commonDefaultId: string; // ID of the non-deletable "common default"
}
