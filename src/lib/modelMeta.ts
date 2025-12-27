import type { OpenRouterModel } from "../types/openrouter";

export type ModelProvider = string;

export interface ModelCapabilities {
  likelyImageInput: boolean;
  likelyImageOutput: boolean;
  provider: ModelProvider;
}

export function getModelProvider(modelId: string): ModelProvider {
  const [provider] = modelId.split("/");
  return provider || "unknown";
}

export function inferModelCapabilities(
  model: OpenRouterModel,
): ModelCapabilities {
  const haystack = `${model.id} ${model.name}`.toLowerCase();
  const likelyImageInput =
    /(vision|multimodal|image|vl|gpt-4o|gpt-4\.1|gemini|claude-3|claude-3\.5|claude-3\.7|llava|pixtral)/.test(
      haystack,
    );

  const likelyImageOutput =
    /(sdxl|stable-diffusion|dall|midjourney|flux|imagen|dream|diffusion|image generation|text-to-image|txt2img|gpt-5|gemini.*image|nano.*banana)/.test(
      haystack,
    );

  return {
    provider: getModelProvider(model.id),
    likelyImageInput,
    likelyImageOutput,
  };
}

export function inferModelModalities(model: OpenRouterModel): string[] {
  const modalities: string[] = ["text"];

  // First, check if OpenRouter provides output_modalities in the model data
  if (Array.isArray(model.output_modalities)) {
    if (model.output_modalities.includes("image")) {
      modalities.push("image");
      if (import.meta.env.DEV) {
        console.debug(
          `[ModelMeta] Enabling image modality for ${model.id} (from output_modalities)`,
        );
      }
      return modalities;
    } else {
      if (import.meta.env.DEV) {
        console.debug(
          `[ModelMeta] Model ${model.id} output_modalities:`,
          model.output_modalities,
        );
      }
    }
  }

  // Fallback to pattern matching if output_modalities not available
  const capabilities = inferModelCapabilities(model);
  const haystack = `${model.id} ${model.name}`.toLowerCase();

  // Check for known image generation models
  // Note: GPT-5.x might not actually support image generation - check model docs
  const imageGenPatterns = [
    /gemini.*image/i,
    /gemini.*flash.*image/i,
    /gemini-2\.5-flash-image/i,
    /nano.*banana/i,
    /image.*preview/i,
    /dall/i,
    /midjourney/i,
    /stable.*diffusion/i,
    /flux/i,
    /imagen/i,
  ];

  if (
    capabilities.likelyImageOutput ||
    imageGenPatterns.some((pattern) => pattern.test(haystack))
  ) {
    modalities.push("image");
    if (import.meta.env.DEV) {
      console.debug(
        `[ModelMeta] Enabling image modality for ${model.id} (from pattern matching)`,
      );
    }
  } else {
    if (import.meta.env.DEV) {
      console.debug(
        `[ModelMeta] NOT enabling image modality for ${model.id} (${model.name})`,
      );
    }
  }

  return modalities;
}
