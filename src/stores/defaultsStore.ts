import { atom } from "nanostores";
import type { DefaultEntry, DefaultsState } from "../types/db";
import { getDefaults, saveDefaults } from "../lib/idb";
import { createId } from "../lib/utils";

const COMMON_DEFAULT_ID = "common-default";

const defaultDefaultsState: DefaultsState = {
  entries: [
    {
      id: COMMON_DEFAULT_ID,
      name: "Common Default",
      modelFilter: "", // Empty filter applies to all models
      systemMessage: undefined,
      systemMessageSet: false, // Not set by default
      streamReasoning: true,
      streamReasoningSet: false, // Not set by default
      reasoningEffort: "medium",
      reasoningEffortSet: false, // Not set by default
      temperature: undefined,
      temperatureSet: false, // Not set by default
      keepOnlyLastImage: false,
      keepOnlyLastImageSet: false,
      outputFormat: "png",
      outputFormatSet: true, // Set to true to enable PNG output format
      imageAspectRatio: "1:1",
      imageAspectRatioSet: true,
      imageSize: "1K",
      imageSizeSet: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    {
      id: "nano-banana-3-one-image",
      name: "Nano Banana 3 (keep one image)",
      modelFilter: "nano[-_ ]?banana[-_ ]?3",
      systemMessage: undefined,
      systemMessageSet: false,
      streamReasoning: true,
      streamReasoningSet: false,
      reasoningEffort: "medium",
      reasoningEffortSet: false,
      temperature: undefined,
      temperatureSet: false,
      keepOnlyLastImage: true,
      keepOnlyLastImageSet: true,
      outputFormat: "png",
      outputFormatSet: false,
      imageAspectRatio: "1:1",
      imageAspectRatioSet: false,
      imageSize: "1K",
      imageSizeSet: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  ],
  commonDefaultId: COMMON_DEFAULT_ID,
};

export const $defaults = atom<DefaultsState>(defaultDefaultsState);

export async function loadDefaults() {
  const stored = await getDefaults();
  if (stored) {
    // Migrate all entries to include new fields if missing
    let needsSave = false;
    stored.entries.forEach((entry) => {
      const raw = entry as unknown as Partial<DefaultEntry>;
      if (raw.reasoningEffort === undefined) {
        raw.reasoningEffort = "medium";
        needsSave = true;
      }
      if (raw.reasoningEffortSet === undefined) {
        raw.reasoningEffortSet = false;
        needsSave = true;
      }
      if (raw.temperatureSet === undefined) {
        raw.temperatureSet = false;
        needsSave = true;
      }
      if (raw.systemMessageSet === undefined) {
        raw.systemMessageSet = Boolean(raw.systemMessage);
        needsSave = true;
      }
      if (raw.streamReasoningSet === undefined) {
        raw.streamReasoningSet = false;
        needsSave = true;
      }
      if (raw.keepOnlyLastImage === undefined) {
        raw.keepOnlyLastImage = false;
        needsSave = true;
      }
      if (raw.keepOnlyLastImageSet === undefined) {
        raw.keepOnlyLastImageSet = false;
        needsSave = true;
      }
      if (raw.outputFormat === undefined) {
        raw.outputFormat = "png";
        needsSave = true;
      }
      if (raw.outputFormatSet === undefined) {
        // For common default, set to true; for others, set to false
        raw.outputFormatSet = raw.id === COMMON_DEFAULT_ID;
        needsSave = true;
      }
      if (raw.imageAspectRatio === undefined) {
        raw.imageAspectRatio = "1:1";
        needsSave = true;
      }
      if (raw.imageAspectRatioSet === undefined) {
        raw.imageAspectRatioSet = raw.id === COMMON_DEFAULT_ID;
        needsSave = true;
      }
      if (raw.imageSize === undefined) {
        raw.imageSize = "1K";
        needsSave = true;
      }
      if (raw.imageSizeSet === undefined) {
        raw.imageSizeSet = raw.id === COMMON_DEFAULT_ID;
        needsSave = true;
      }
    });

    // Ensure common default exists
    const hasCommonDefault = stored.entries.some(
      (e) => e.id === COMMON_DEFAULT_ID,
    );
    if (!hasCommonDefault) {
      stored.entries.push({
        id: COMMON_DEFAULT_ID,
        name: "Common Default",
        modelFilter: "",
        systemMessage: undefined,
        systemMessageSet: false,
        streamReasoning: true,
        streamReasoningSet: false,
        reasoningEffort: "medium",
        reasoningEffortSet: false,
        temperature: undefined,
        temperatureSet: false,
        keepOnlyLastImage: false,
        keepOnlyLastImageSet: false,
        outputFormat: "png",
        outputFormatSet: true,
        imageAspectRatio: "1:1",
        imageAspectRatioSet: true,
        imageSize: "1K",
        imageSizeSet: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      needsSave = true;
    }

    const hasNanoBanana3 = stored.entries.some(
      (e) => e.id === "nano-banana-3-one-image",
    );
    if (!hasNanoBanana3) {
      stored.entries.push({
        id: "nano-banana-3-one-image",
        name: "Nano Banana 3 (keep one image)",
        modelFilter: "nano[-_ ]?banana[-_ ]?3",
        systemMessage: undefined,
        systemMessageSet: false,
        streamReasoning: true,
        streamReasoningSet: false,
        reasoningEffort: "medium",
        reasoningEffortSet: false,
        temperature: undefined,
        temperatureSet: false,
        keepOnlyLastImage: true,
        keepOnlyLastImageSet: true,
        outputFormat: "png",
        outputFormatSet: false,
        imageAspectRatio: "1:1",
        imageAspectRatioSet: false,
        imageSize: "1K",
        imageSizeSet: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      needsSave = true;
    }

    if (needsSave) {
      await saveDefaults(stored);
    }
    $defaults.set(stored);
  } else {
    await saveDefaults(defaultDefaultsState);
    $defaults.set(defaultDefaultsState);
  }
}

export async function createDefault(
  entry: Omit<DefaultEntry, "id" | "createdAt" | "updatedAt">,
) {
  const defaults = $defaults.get();
  const newEntry: DefaultEntry = {
    ...entry,
    id: createId("default"),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const updated: DefaultsState = {
    ...defaults,
    entries: [...defaults.entries, newEntry],
  };
  $defaults.set(updated);
  await saveDefaults(updated);
}

export async function updateDefault(
  id: string,
  updates: Partial<Omit<DefaultEntry, "id" | "createdAt">>,
) {
  const defaults = $defaults.get();
  const isCommonDefault = id === COMMON_DEFAULT_ID;
  const updated: DefaultsState = {
    ...defaults,
    entries: defaults.entries.map((entry) => {
      if (entry.id !== id) return entry;
      // Common default: allow updating systemMessage, streamReasoning, reasoningEffort, temperature, and image settings
      if (isCommonDefault) {
        return {
          ...entry,
          systemMessage: updates.systemMessage ?? entry.systemMessage,
          systemMessageSet: updates.systemMessageSet ?? entry.systemMessageSet,
          streamReasoning: updates.streamReasoning ?? entry.streamReasoning,
          streamReasoningSet:
            updates.streamReasoningSet ?? entry.streamReasoningSet,
          reasoningEffort: updates.reasoningEffort ?? entry.reasoningEffort,
          reasoningEffortSet:
            updates.reasoningEffortSet ?? entry.reasoningEffortSet,
          temperature: updates.temperature ?? entry.temperature,
          temperatureSet: updates.temperatureSet ?? entry.temperatureSet,
          keepOnlyLastImage:
            updates.keepOnlyLastImage ?? entry.keepOnlyLastImage,
          keepOnlyLastImageSet:
            updates.keepOnlyLastImageSet ?? entry.keepOnlyLastImageSet,
          outputFormat: updates.outputFormat ?? entry.outputFormat,
          outputFormatSet: updates.outputFormatSet ?? entry.outputFormatSet,
          imageAspectRatio: updates.imageAspectRatio ?? entry.imageAspectRatio,
          imageAspectRatioSet:
            updates.imageAspectRatioSet ?? entry.imageAspectRatioSet,
          imageSize: updates.imageSize ?? entry.imageSize,
          imageSizeSet: updates.imageSizeSet ?? entry.imageSizeSet,
          updatedAt: Date.now(),
        };
      }
      // Regular entries: allow all updates except modelFilter if it's empty
      return {
        ...entry,
        ...updates,
        updatedAt: Date.now(),
      };
    }),
  };
  $defaults.set(updated);
  await saveDefaults(updated);
}

export async function deleteDefault(id: string) {
  if (id === COMMON_DEFAULT_ID) {
    throw new Error("Cannot delete common default");
  }
  const defaults = $defaults.get();
  const updated: DefaultsState = {
    ...defaults,
    entries: defaults.entries.filter((e) => e.id !== id),
  };
  $defaults.set(updated);
  await saveDefaults(updated);
}

export function getMatchingDefault(modelId: string): DefaultEntry | null {
  const merged = getMergedDefaults(modelId);
  return merged;
}

/**
 * Merges all matching defaults for a model, with common default as base
 * and more specific defaults overriding only fields that are explicitly set.
 */
export function getMergedDefaults(modelId: string): DefaultEntry | null {
  const defaults = $defaults.get();
  // Find entries with matching regex filters
  const matchingEntries = defaults.entries.filter((entry) => {
    if (!entry.modelFilter) {
      // Empty filter matches all (common default)
      return true;
    }
    try {
      // Make regex case-insensitive for more flexible matching
      const regex = new RegExp(entry.modelFilter, "i");
      return regex.test(modelId);
    } catch {
      // Invalid regex, skip
      return false;
    }
  });

  if (matchingEntries.length === 0) return null;

  // Separate common default from specific defaults
  const commonDefault = matchingEntries.find((e) => !e.modelFilter);
  const specificDefaults = matchingEntries
    .filter((e) => e.modelFilter)
    .sort((a, b) => a.createdAt - b.createdAt); // Sort by creation date for consistent ordering

  // Start with common default as base, or create empty entry if no common default
  const merged: DefaultEntry = commonDefault
    ? { ...commonDefault }
    : {
        id: "",
        name: "",
        modelFilter: "",
        systemMessageSet: false,
        streamReasoningSet: false,
        reasoningEffortSet: false,
        temperatureSet: false,
        keepOnlyLastImageSet: false,
        outputFormatSet: false,
        imageAspectRatioSet: false,
        imageSizeSet: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

  // Apply specific defaults on top, only overriding fields that are explicitly set
  for (const specific of specificDefaults) {
    // System message
    if (specific.systemMessageSet) {
      merged.systemMessage = specific.systemMessage;
      merged.systemMessageSet = true;
    }

    // Stream reasoning
    if (specific.streamReasoningSet) {
      merged.streamReasoning = specific.streamReasoning;
      merged.streamReasoningSet = true;
    }

    // Reasoning effort
    if (specific.reasoningEffortSet) {
      merged.reasoningEffort = specific.reasoningEffort;
      merged.reasoningEffortSet = true;
    }

    // Temperature
    if (specific.temperatureSet) {
      merged.temperature = specific.temperature;
      merged.temperatureSet = true;
    }

    // Keep only last image
    if (specific.keepOnlyLastImageSet) {
      merged.keepOnlyLastImage = specific.keepOnlyLastImage;
      merged.keepOnlyLastImageSet = true;
    }

    // Output format
    if (specific.outputFormatSet) {
      merged.outputFormat = specific.outputFormat;
      merged.outputFormatSet = true;
    }

    // Image aspect ratio
    if (specific.imageAspectRatioSet) {
      merged.imageAspectRatio = specific.imageAspectRatio;
      merged.imageAspectRatioSet = true;
    }

    // Image size
    if (specific.imageSizeSet) {
      merged.imageSize = specific.imageSize;
      merged.imageSizeSet = true;
    }
  }

  return merged;
}
