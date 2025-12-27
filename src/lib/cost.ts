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
}): number {
  if (!pricing) return 0;

  // OpenRouter returns pricing as strings (e.g., "0.0000003"), convert to numbers
  const promptPricePerToken = toFiniteNumber(pricing.prompt) ?? 0;
  const completionPricePerToken = toFiniteNumber(pricing.completion) ?? 0;
  const requestPrice = toFiniteNumber(pricing.request) ?? 0;
  const imagePrice = toFiniteNumber(pricing.image) ?? 0;

  // OpenRouter stores pricing as per-token values (very small decimals).
  // Multiply directly by token count to get cost.
  // Example: 0.0000003 per token * 1M tokens = $0.30
  const promptCost = promptTokens * promptPricePerToken;
  const completionCost = completionTokens * completionPricePerToken;

  const imageCost = outputImages * imagePrice;
  const total = promptCost + completionCost + requestPrice + imageCost;

  return Number.isFinite(total) ? total : 0;
}
