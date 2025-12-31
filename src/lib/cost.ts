import type { OpenRouterModel } from "../types/openrouter";

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function calculateModelCostUsd({
  pricing,
  promptTokens,
  completionTokens,
  outputImages,
}: {
  pricing: OpenRouterModel["pricing"] | undefined;
  promptTokens: number;
  completionTokens: number;
  outputImages: number;
}): number | null {
  if (!pricing) return null;

  const promptPricePerToken = toFiniteNumber(pricing.prompt);
  const completionPricePerToken = toFiniteNumber(pricing.completion);
  const requestPrice = toFiniteNumber(pricing.request);
  const imagePrice = toFiniteNumber(pricing.image);

  if (
    promptPricePerToken === null ||
    completionPricePerToken === null ||
    requestPrice === null ||
    imagePrice === null
  ) {
    return null;
  }

  const promptCost = promptTokens * promptPricePerToken;
  const completionCost = completionTokens * completionPricePerToken;

  const imageCost = outputImages * imagePrice;
  const total = promptCost + completionCost + requestPrice + imageCost;

  return Number.isFinite(total) ? total : null;
}
