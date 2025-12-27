export interface OpenRouterModel {
  id: string;
  name: string;
  description?: string;
  context_length?: number;
  pricing?: {
    prompt?: number;
    completion?: number;
    image?: number;
    request?: number;
  };
  parameters?: Record<string, unknown>;
  // OpenRouter may include these fields
  output_modalities?: string[];
  input_modalities?: string[];
}

export interface OpenRouterModelsResponse {
  data: OpenRouterModel[];
}

export interface OpenRouterMessage {
  role: "system" | "user" | "assistant" | "tool";
  content:
    | string
    | Array<
        | { type: "text"; text: string }
        | { type: "image_url"; image_url: { url: string } }
      >;
}

export interface OpenRouterCompletionRequest {
  model: string;
  messages: OpenRouterMessage[];
  stream?: boolean;
  include_usage?: boolean;
  stream_options?: {
    include_usage?: boolean;
  };
  temperature?: number;
  top_p?: number;
  top_k?: number;
  max_tokens?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  modalities?: string[];
  transforms?: string[];
  [key: string]: unknown;
}
