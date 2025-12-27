import { atom } from "nanostores";
import type { OpenRouterModel } from "../types/openrouter";
import { fetchOpenRouterModels } from "../lib/openrouter";
import { getModels, saveModels } from "../lib/idb";
import { setModelParamSchema } from "./settingsStore";
import type { ModelParamSpec } from "../types/db";

export const $models = atom<OpenRouterModel[]>([]);
export const $modelsStatus = atom<"idle" | "loading" | "error">("idle");
export const $modelsError = atom<string | null>(null);

function extractParamSchema(
  model: OpenRouterModel,
): Record<string, ModelParamSpec> {
  const schema: Record<string, ModelParamSpec> = {};
  if (model.parameters && typeof model.parameters === "object") {
    Object.entries(model.parameters).forEach(([key, value]) => {
      if (typeof value === "object" && value) {
        schema[key] = {
          label: key,
          type: "string",
        };
      }
    });
  }
  return schema;
}

export async function loadStoredModels() {
  const stored = await getModels();
  if (stored.length) {
    $models.set(stored);
  }
}

export async function fetchModels(apiKey: string) {
  $modelsStatus.set("loading");
  $modelsError.set(null);
  try {
    const response = await fetchOpenRouterModels(apiKey);
    const models = response.data ?? [];
    $models.set(models);
    await saveModels(models);
    await Promise.all(
      models.map((model) =>
        setModelParamSchema(model.id, extractParamSchema(model)),
      ),
    );
    $modelsStatus.set("idle");
  } catch (error) {
    $modelsStatus.set("error");
    $modelsError.set((error as Error).message);
  }
}
