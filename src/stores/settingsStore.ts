import { map } from "nanostores";
import type { ModelParamSpec, SettingsState } from "../types/db";
import { getSettings, saveSettings } from "../lib/idb";

// Increment this version when breaking changes require clearing storage
const STORE_VERSION = 1;

const defaultSettings: SettingsState = {
  id: "settings",
  apiKey: "",
  selectedModelIds: [],
  perModelParameters: {},
  modelParamSchema: {},
  storeVersion: STORE_VERSION,
};

export const $settings = map<SettingsState>(defaultSettings);

async function clearAllStorageExceptApiKey(): Promise<string> {
  const stored = await getSettings();
  const apiKey = stored?.apiKey ?? "";

  // Clear all IndexedDB stores except settings (we'll recreate it)
  const { clearAllStorage } = await import("../lib/idb");
  await clearAllStorage();

  return apiKey;
}

export async function loadSettings() {
  const stored = await getSettings();

  // Check store version - if stored version doesn't match or doesn't exist, clear everything
  const storedVersion = stored?.storeVersion;
  if (storedVersion !== STORE_VERSION) {
    if (stored) {
      // Preserve API key before clearing
      const apiKey = await clearAllStorageExceptApiKey();
      const freshSettings: SettingsState = {
        ...defaultSettings,
        apiKey,
        storeVersion: STORE_VERSION,
      };
      await saveSettings(freshSettings);
      $settings.set(freshSettings);
      return;
    }
  }

  if (stored) {
    $settings.set(stored);
  } else {
    const initialSettings: SettingsState = {
      ...defaultSettings,
      storeVersion: STORE_VERSION,
    };
    await saveSettings(initialSettings);
    $settings.set(initialSettings);
  }
}

export async function updateApiKey(apiKey: string) {
  $settings.set({ ...$settings.get(), apiKey });
  await saveSettings($settings.get());
}

export async function toggleModelSelection(modelId: string) {
  const settings = $settings.get();
  const isSelected = settings.selectedModelIds.includes(modelId);
  const selected = isSelected
    ? settings.selectedModelIds.filter((id) => id !== modelId)
    : [...settings.selectedModelIds, modelId];
  const perModelParameters = isSelected
    ? settings.perModelParameters
    : {
        ...settings.perModelParameters,
        [modelId]: {
          overrideTemperature: false,
          temperature: 0.7,
          ...(settings.perModelParameters[modelId] ?? {}),
        },
      };
  const updated = {
    ...settings,
    selectedModelIds: selected,
    perModelParameters,
  };
  $settings.set(updated);
  await saveSettings(updated);
}

export async function updateModelParam(
  modelId: string,
  key: string,
  value: string | number | boolean,
) {
  const settings = $settings.get();
  const modelParams = settings.perModelParameters[modelId] ?? {};
  const updated = {
    ...settings,
    perModelParameters: {
      ...settings.perModelParameters,
      [modelId]: { ...modelParams, [key]: value },
    },
  };
  $settings.set(updated);
  await saveSettings(updated);
}

export async function setModelParamSchema(
  modelId: string,
  schema: Record<string, ModelParamSpec>,
) {
  const settings = $settings.get();
  const updated = {
    ...settings,
    modelParamSchema: {
      ...settings.modelParamSchema,
      [modelId]: schema,
    },
  };
  $settings.set(updated);
  await saveSettings(updated);
}

export async function setSelectedModels(modelIds: string[]) {
  const settings = $settings.get();
  const perModelParameters = { ...settings.perModelParameters };
  modelIds.forEach((modelId) => {
    perModelParameters[modelId] = {
      overrideTemperature: false,
      temperature: 0.7,
      ...(perModelParameters[modelId] ?? {}),
    };
  });
  const updated = {
    ...settings,
    selectedModelIds: Array.from(new Set(modelIds)),
    perModelParameters,
  };
  $settings.set(updated);
  await saveSettings(updated);
}

export async function moveSelectedModel(modelId: string, delta: -1 | 1) {
  const settings = $settings.get();
  const list = settings.selectedModelIds.slice();
  const index = list.indexOf(modelId);
  if (index === -1) return;
  const nextIndex = index + delta;
  if (nextIndex < 0 || nextIndex >= list.length) return;
  const next = list.slice();
  next.splice(index, 1);
  next.splice(nextIndex, 0, modelId);
  const updated = { ...settings, selectedModelIds: next };
  $settings.set(updated);
  await saveSettings(updated);
}
