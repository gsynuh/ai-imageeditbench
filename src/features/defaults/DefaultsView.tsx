import { useMemo, useState, useEffect } from "react";
import { useStore } from "@nanostores/react";
import styles from "./DefaultsView.module.scss";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import { Checkbox } from "../../components/ui/checkbox";
import { SelectPopover } from "../../components/ui/select-popover";
import { Slider } from "../../components/ui/slider";
import {
  $defaults,
  loadDefaults,
  createDefault,
  updateDefault,
  deleteDefault,
} from "../../stores/defaultsStore";
import type { DefaultEntry } from "../../types/db";
import { Trash2, Plus, Save, X } from "lucide-react";
import {
  setHeaderRightActions,
  type HeaderAction,
} from "../../stores/headerStore";
import { $models } from "../../stores/modelsStore";
import type { OpenRouterModel } from "../../types/openrouter";
import { getModelsMatchingFilter, tryCompileModelFilter } from "./modelFilter";

function DefaultEntryForm({
  entry,
  isCommonDefault,
  models,
  onSave,
  onCancel,
}: {
  entry: DefaultEntry | null;
  isCommonDefault: boolean;
  models: OpenRouterModel[];
  onSave: (entry: Omit<DefaultEntry, "id" | "createdAt" | "updatedAt">) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(entry?.name ?? "");
  const [modelFilter, setModelFilter] = useState(entry?.modelFilter ?? "");
  const [systemMessage, setSystemMessage] = useState(
    entry?.systemMessage ?? "",
  );
  const [systemMessageSet, setSystemMessageSet] = useState(
    entry?.systemMessageSet ?? false,
  );
  const [streamReasoning, setStreamReasoning] = useState(
    entry?.streamReasoning ?? true,
  );
  const [streamReasoningSet, setStreamReasoningSet] = useState(
    entry?.streamReasoningSet ?? false,
  );
  const [reasoningEffort, setReasoningEffort] = useState<
    "low" | "medium" | "high"
  >(entry?.reasoningEffort ?? "medium");
  const [reasoningEffortSet, setReasoningEffortSet] = useState(
    entry?.reasoningEffortSet ?? false,
  );
  const [temperature, setTemperature] = useState<number | undefined>(
    entry?.temperature ?? 0.7,
  );
  const [temperatureSet, setTemperatureSet] = useState(
    entry?.temperatureSet ?? false,
  );
  const [keepOnlyLastImage, setKeepOnlyLastImage] = useState(
    entry?.keepOnlyLastImage ?? false,
  );
  const [keepOnlyLastImageSet, setKeepOnlyLastImageSet] = useState(
    entry?.keepOnlyLastImageSet ?? false,
  );
  const [outputFormat, setOutputFormat] = useState<"png" | "jpeg" | "webp">(
    entry?.outputFormat ?? "png",
  );
  const [outputFormatSet, setOutputFormatSet] = useState(
    entry?.outputFormatSet ?? false,
  );
  const [filterError, setFilterError] = useState<string | null>(null);

  const matchingModels = useMemo(() => {
    const filter = modelFilter.trim();
    if (!filter) return models;
    if (filterError) return [];
    if (!tryCompileModelFilter(filter)) return [];
    return getModelsMatchingFilter(models, filter);
  }, [models, modelFilter, filterError]);

  const validateFilter = (filter: string) => {
    if (!filter) {
      setFilterError(null);
      return true;
    }
    try {
      new RegExp(filter);
      setFilterError(null);
      return true;
    } catch {
      setFilterError("Invalid regex pattern");
      return false;
    }
  };

  const handleFilterChange = (value: string) => {
    setModelFilter(value);
    validateFilter(value);
  };

  const handleSave = () => {
    if (!name.trim()) return;
    if (filterError) return;
    if (!validateFilter(modelFilter)) return;

    onSave({
      name: name.trim(),
      modelFilter: modelFilter.trim(),
      systemMessage: systemMessageSet
        ? systemMessage.trim() || undefined
        : undefined,
      systemMessageSet,
      streamReasoning: streamReasoningSet ? streamReasoning : true,
      streamReasoningSet,
      reasoningEffort: reasoningEffortSet ? reasoningEffort : undefined,
      reasoningEffortSet,
      temperature: temperatureSet ? temperature : undefined,
      temperatureSet,
      keepOnlyLastImage: keepOnlyLastImageSet ? keepOnlyLastImage : false,
      keepOnlyLastImageSet,
      outputFormat: outputFormatSet ? outputFormat : undefined,
      outputFormatSet,
    });
  };

  return (
    <div className={styles.entryForm}>
      <div className={styles.formRow}>
        <label htmlFor="entry-name" className="text-xs text-[var(--muted)]">
          Name
        </label>
        <Input
          id="entry-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={isCommonDefault}
          placeholder="e.g., GPT Default"
        />
      </div>
      <div className={styles.formRow}>
        <label htmlFor="entry-filter" className="text-xs text-[var(--muted)]">
          Model Filter (Regex)
        </label>
        <Input
          id="entry-filter"
          value={modelFilter}
          onChange={(e) => handleFilterChange(e.target.value)}
          disabled={isCommonDefault}
          placeholder="e.g., openai/gpt.* or ^anthropic/"
        />
        {filterError && (
          <p className="text-xs text-[var(--danger)]">{filterError}</p>
        )}
        <p className="text-xs text-[var(--muted)]">
          {isCommonDefault
            ? "Common default applies to all models (no filter)"
            : "Leave empty to match all models, or use regex pattern"}
        </p>
        {!filterError && models.length > 0 && (
          <div className={styles.matchPreview}>
            <div className={styles.matchPreviewHeader}>
              <span className="text-xs text-[var(--muted)]">
                Matches:{" "}
                {modelFilter.trim()
                  ? matchingModels.length
                  : `all (${models.length})`}
              </span>
              {modelFilter.trim() && matchingModels.length > 12 && (
                <span className="text-xs text-[var(--muted)]">
                  showing first 12
                </span>
              )}
            </div>
            <div className={styles.matchPreviewList}>
              {matchingModels.slice(0, 12).map((model) => (
                <code key={model.id} className={styles.matchPreviewItem}>
                  {model.id}
                </code>
              ))}
              {modelFilter.trim() && matchingModels.length === 0 && (
                <span className="text-xs text-[var(--muted)]">
                  No models match this pattern.
                </span>
              )}
            </div>
          </div>
        )}
      </div>
      <div
        className={`${styles.formRow} ${styles.formFieldGroup} ${
          !systemMessageSet ? styles.disabled : ""
        }`}
      >
        <label className="flex items-center gap-2">
          <Checkbox
            checked={systemMessageSet}
            onCheckedChange={(value) => setSystemMessageSet(Boolean(value))}
          />
          <span className="text-xs text-[var(--muted)]">System Message</span>
        </label>
        <Textarea
          id="entry-system-message"
          value={systemMessage}
          onChange={(e) => setSystemMessage(e.target.value)}
          placeholder="Default system message to prepend to sessions"
          rows={4}
          disabled={!systemMessageSet}
        />
      </div>
      <div
        className={`${styles.formRow} ${styles.formFieldGroup} ${
          !streamReasoningSet ? styles.disabled : ""
        }`}
      >
        <label className="flex items-center gap-2">
          <Checkbox
            checked={streamReasoningSet}
            onCheckedChange={(value) => setStreamReasoningSet(Boolean(value))}
          />
          <span className="text-xs text-[var(--muted)]">
            Stream reasoning tokens
          </span>
        </label>
        {streamReasoningSet && (
          <label className="flex items-center gap-2 ml-6">
            <Checkbox
              checked={streamReasoning}
              onCheckedChange={(value) => setStreamReasoning(Boolean(value))}
            />
            <span className="text-xs text-[var(--muted)]">Enabled</span>
          </label>
        )}
      </div>
      <div
        className={`${styles.formRow} ${styles.formFieldGroup} ${
          !reasoningEffortSet ? styles.disabled : ""
        }`}
      >
        <label className="flex items-center gap-2">
          <Checkbox
            checked={reasoningEffortSet}
            onCheckedChange={(value) => setReasoningEffortSet(Boolean(value))}
          />
          <span className="text-xs text-[var(--muted)]">Reasoning Effort</span>
        </label>
        {reasoningEffortSet && (
          <SelectPopover
            value={reasoningEffort}
            onValueChange={(value) =>
              setReasoningEffort(value as "low" | "medium" | "high")
            }
            items={[
              { value: "low", label: "Low" },
              { value: "medium", label: "Medium" },
              { value: "high", label: "High" },
            ]}
          />
        )}
      </div>
      <div
        className={`${styles.formRow} ${styles.formFieldGroup} ${
          !temperatureSet ? styles.disabled : ""
        }`}
      >
        <label className="flex items-center gap-2">
          <Checkbox
            checked={temperatureSet}
            onCheckedChange={(value) => setTemperatureSet(Boolean(value))}
          />
          <span className="text-xs text-[var(--muted)]">Temperature</span>
        </label>
        {temperatureSet && (
          <>
            <div className="flex items-center gap-3 px-2">
              <Slider
                value={temperature !== undefined ? [temperature] : [0.7]}
                onValueChange={(value) => setTemperature(value[0])}
                min={0}
                max={1.5}
                step={0.01}
                className="flex-1"
              />
              <Input
                type="number"
                value={
                  temperature !== undefined ? temperature.toFixed(2) : "0.70"
                }
                onChange={(e) => {
                  const val = parseFloat(e.target.value);
                  if (!isNaN(val) && val >= 0 && val <= 1.5) {
                    setTemperature(val);
                  }
                }}
                min={0}
                max={1.5}
                step={0.01}
                className="w-20"
              />
            </div>
            <div className="flex justify-between text-xs text-[var(--muted)] px-2">
              <span>0</span>
              <span>1.5</span>
            </div>
          </>
        )}
      </div>
      <div
        className={`${styles.formRow} ${styles.formFieldGroup} ${
          !keepOnlyLastImageSet ? styles.disabled : ""
        }`}
      >
        <label className="flex items-center gap-2">
          <Checkbox
            checked={keepOnlyLastImageSet}
            onCheckedChange={(value) => setKeepOnlyLastImageSet(Boolean(value))}
          />
          <span className="text-xs text-[var(--muted)]">
            Keep Only One Image
          </span>
        </label>
        {keepOnlyLastImageSet && (
          <label className="flex items-center gap-2 ml-6">
            <Checkbox
              checked={keepOnlyLastImage}
              onCheckedChange={(value) => setKeepOnlyLastImage(Boolean(value))}
            />
            <span className="text-xs text-[var(--muted)]">
              Keep only last received image
            </span>
          </label>
        )}
        <p className="text-xs text-[var(--muted)] ml-6">
          If enabled, the app ignores all but the last image a model returns.
        </p>
      </div>
      <div
        className={`${styles.formRow} ${styles.formFieldGroup} ${
          !outputFormatSet ? styles.disabled : ""
        }`}
      >
        <label className="flex items-center gap-2">
          <Checkbox
            checked={outputFormatSet}
            onCheckedChange={(value) => setOutputFormatSet(Boolean(value))}
          />
          <span className="text-xs text-[var(--muted)]">
            Image Output Format
          </span>
        </label>
        {outputFormatSet && (
          <SelectPopover
            value={outputFormat}
            onValueChange={(value) =>
              setOutputFormat(value as "png" | "jpeg" | "webp")
            }
            items={[
              { value: "png", label: "PNG" },
              { value: "jpeg", label: "JPEG" },
              { value: "webp", label: "WebP" },
            ]}
          />
        )}
        <p className="text-xs text-[var(--muted)] ml-6">
          Format for generated images. PNG preserves quality, JPEG/WebP may
          compress.
        </p>
      </div>
      <div className={styles.formActions}>
        <Button type="button" onClick={handleSave} disabled={!!filterError}>
          <Save size={16} />
          {entry ? "Update" : "Create"}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          <X size={16} />
          Cancel
        </Button>
      </div>
    </div>
  );
}

export default function DefaultsView() {
  const defaults = useStore($defaults);
  const models = useStore($models);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [showNewForm, setShowNewForm] = useState(false);

  useEffect(() => {
    const actions: HeaderAction[] = [
      {
        key: "new-default",
        label: "New Default",
        icon: Plus,
        onClick: () => setShowNewForm(true),
        variant: "default",
        disabled: showNewForm || editingId !== null,
      },
    ];
    setHeaderRightActions(actions);
    loadDefaults();

    return () => {
      setHeaderRightActions([]);
    };
  }, [showNewForm, editingId]);

  const handleCreate = async (
    entry: Omit<DefaultEntry, "id" | "createdAt" | "updatedAt">,
  ) => {
    await createDefault(entry);
    setShowNewForm(false);
  };

  const handleUpdate = async (
    id: string,
    entry: Partial<Omit<DefaultEntry, "id" | "createdAt" | "updatedAt">>,
  ) => {
    await updateDefault(id, entry);
    setEditingId(null);
  };

  const handleDelete = async (id: string) => {
    if (
      confirm(
        "Are you sure you want to delete this default? This cannot be undone.",
      )
    ) {
      await deleteDefault(id);
    }
  };

  return (
    <div className={styles.defaultsView}>
      {showNewForm && (
        <div className={styles.panel}>
          <h3>Create New Default</h3>
          <DefaultEntryForm
            key="new-default"
            entry={null}
            isCommonDefault={false}
            models={models}
            onSave={handleCreate}
            onCancel={() => setShowNewForm(false)}
          />
        </div>
      )}

      <div className={styles.panel}>
        <div className={styles.entryList}>
          {defaults.entries.map((entry) => {
            const isEditing = editingId === entry.id;
            const isCommon = entry.id === defaults.commonDefaultId;

            if (isEditing) {
              return (
                <div key={entry.id} className={styles.entryCard}>
                  <h3>Edit Default</h3>
                  <DefaultEntryForm
                    key={`edit-${entry.id}`}
                    entry={entry}
                    isCommonDefault={isCommon}
                    models={models}
                    onSave={(updates) => handleUpdate(entry.id, updates)}
                    onCancel={() => setEditingId(null)}
                  />
                </div>
              );
            }

            const filter = entry.modelFilter.trim();
            const compiled = filter ? tryCompileModelFilter(filter) : null;
            const matchCount =
              models.length === 0
                ? null
                : filter
                  ? compiled
                    ? getModelsMatchingFilter(models, filter).length
                    : null
                  : models.length;

            return (
              <div key={entry.id} className={styles.entryCard}>
                <div className={styles.entryHeader}>
                  <div>
                    <div className={styles.entryTitle}>{entry.name}</div>
                    {isCommon && (
                      <span className={styles.commonDefaultBadge}>
                        Common Default
                      </span>
                    )}
                  </div>
                  <div className={styles.formActions}>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      onClick={() => setEditingId(entry.id)}
                    >
                      Edit
                    </Button>
                    {!isCommon && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDelete(entry.id)}
                      >
                        <Trash2 size={16} />
                        Delete
                      </Button>
                    )}
                  </div>
                </div>
                <div className={styles.formRow}>
                  <span className="text-xs text-[var(--muted)]">
                    Model Filter:
                  </span>
                  <code className="text-xs">
                    {entry.modelFilter || "(matches all models)"}
                  </code>
                  {models.length > 0 && (
                    <span className="text-xs text-[var(--muted)]">
                      Matches:{" "}
                      {filter
                        ? matchCount === null
                          ? "invalid regex"
                          : matchCount
                        : `all (${models.length})`}
                    </span>
                  )}
                </div>
                {entry.systemMessageSet && entry.systemMessage && (
                  <div className={styles.formRow}>
                    <span className="text-xs text-[var(--muted)]">
                      System Message:
                    </span>
                    <p className="text-sm">{entry.systemMessage}</p>
                  </div>
                )}
                {entry.streamReasoningSet && (
                  <div className={styles.formRow}>
                    <span className="text-xs text-[var(--muted)]">
                      Stream Reasoning: {entry.streamReasoning ? "Yes" : "No"}
                    </span>
                  </div>
                )}
                {entry.reasoningEffortSet && (
                  <div className={styles.formRow}>
                    <span className="text-xs text-[var(--muted)]">
                      Reasoning Effort: {entry.reasoningEffort ?? "medium"}
                    </span>
                  </div>
                )}
                {entry.temperatureSet && (
                  <div className={styles.formRow}>
                    <span className="text-xs text-[var(--muted)]">
                      Temperature:{" "}
                      {entry.temperature !== undefined
                        ? entry.temperature.toFixed(2)
                        : "Not set"}
                    </span>
                  </div>
                )}
                {entry.keepOnlyLastImageSet && (
                  <div className={styles.formRow}>
                    <span className="text-xs text-[var(--muted)]">
                      Keep Only One Image:{" "}
                      {entry.keepOnlyLastImage ? "Yes" : "No"}
                    </span>
                  </div>
                )}
                {entry.outputFormatSet && (
                  <div className={styles.formRow}>
                    <span className="text-xs text-[var(--muted)]">
                      Image Output Format: {entry.outputFormat?.toUpperCase()}
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
