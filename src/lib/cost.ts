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

  const promptPricePerM = toFiniteNumber(pricing.prompt) ?? 0;
  const completionPricePerM = toFiniteNumber(pricing.completion) ?? 0;
  const requestPrice = toFiniteNumber(pricing.request) ?? 0;
  const imagePrice = toFiniteNumber(pricing.image) ?? 0;

  const promptCost = (promptTokens * promptPricePerM) / 1_000_000;
  const completionCost = (completionTokens * completionPricePerM) / 1_000_000;
  const imageCost = outputImages * imagePrice;
  const total = promptCost + completionCost + requestPrice + imageCost;

  return Number.isFinite(total) ? total : 0;
}
