import type { OpenRouterModel } from "../../types/openrouter";

export function tryCompileModelFilter(pattern: string): RegExp | null {
  const normalized = pattern.trim();
  if (!normalized) return null;
  try {
    // Make regex case-insensitive for more flexible matching
    return new RegExp(normalized, "i");
  } catch {
    return null;
  }
}

export function getModelsMatchingFilter(
  models: OpenRouterModel[],
  pattern: string,
): OpenRouterModel[] {
  const regex = tryCompileModelFilter(pattern);
  if (!regex) return models;
  return models.filter(
    (model) => regex.test(model.id) || regex.test(model.name),
  );
}
