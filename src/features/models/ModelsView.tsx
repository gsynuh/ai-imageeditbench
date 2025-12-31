import { useMemo, useState } from "react";
import { useStore } from "@nanostores/react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";
import styles from "./ModelsView.module.scss";
import { Button } from "@components/ui/button";
import { Input } from "@components/ui/input";
import { Checkbox } from "@components/ui/checkbox";
import { SelectPopover } from "@components/ui/select-popover";
import {
  $settings,
  setSelectedModels,
  toggleModelSelection,
  updateApiKey,
} from "@stores/settingsStore";
import {
  $models,
  $modelsError,
  $modelsStatus,
  fetchModels,
} from "@stores/modelsStore";
import { inferModelCapabilities } from "../../lib/modelMeta";

interface SortableModelItemProps {
  model: { id: string; name: string };
}

function SortableModelItem({ model }: SortableModelItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: model.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} className={styles.selectedModelItem}>
      <div className={styles.dragHandle} {...attributes} {...listeners}>
        <GripVertical size={16} />
      </div>
      <div className="flex flex-col gap-1 flex-1">
        <span>{model.name}</span>
        <code className="text-xs text-[var(--muted)]">{model.id}</code>
      </div>
      {/*<Button type="button" variant="ghost" size="sm" onClick={onRemove}>
        Remove
      </Button>*/}
    </div>
  );
}

export default function ModelsView() {
  const settings = useStore($settings);
  const models = useStore($models);
  const modelsStatus = useStore($modelsStatus);
  const modelsError = useStore($modelsError);
  const [query, setQuery] = useState("");
  const [providerFilter, setProviderFilter] = useState<string>("all");
  const [showSelectedOnly, setShowSelectedOnly] = useState(false);

  const providers = useMemo(() => {
    const unique = new Set<string>();
    models.forEach((model) =>
      unique.add(inferModelCapabilities(model).provider),
    );
    return Array.from(unique).sort((a, b) => a.localeCompare(b));
  }, [models]);

  const filteredModels = useMemo(() => {
    const queryWords = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return models.filter((model) => {
      const meta = inferModelCapabilities(model);
      if (providerFilter !== "all" && meta.provider !== providerFilter)
        return false;
      if (showSelectedOnly && !settings.selectedModelIds.includes(model.id))
        return false;
      if (queryWords.length > 0) {
        const matchesAllWords = queryWords.every(
          (word) =>
            model.name.toLowerCase().includes(word) ||
            model.id.toLowerCase().includes(word) ||
            meta.provider.toLowerCase().includes(word),
        );
        if (!matchesAllWords) return false;
      }
      return true;
    });
  }, [
    models,
    providerFilter,
    query,
    settings.selectedModelIds,
    showSelectedOnly,
  ]);

  const groupedModels = useMemo(() => {
    const groups = new Map<string, typeof filteredModels>();
    filteredModels.forEach((model) => {
      const provider = inferModelCapabilities(model).provider;
      const list = groups.get(provider) ?? [];
      list.push(model);
      groups.set(provider, list);
    });
    return Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [filteredModels]);

  const selectedModelsList = useMemo(() => {
    return settings.selectedModelIds.map((id) => {
      const model = models.find((m) => m.id === id);
      return model ? { id, name: model.name } : { id, name: id };
    });
  }, [settings.selectedModelIds, models]);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = selectedModelsList.findIndex(
      (item) => item.id === active.id,
    );
    const newIndex = selectedModelsList.findIndex(
      (item) => item.id === over.id,
    );

    if (oldIndex !== -1 && newIndex !== -1) {
      const reordered = arrayMove(selectedModelsList, oldIndex, newIndex);
      setSelectedModels(reordered.map((item) => item.id));
    }
  }

  return (
    <div className={styles.modelsView}>
      <div className={styles.apiRow}>
        <div className={styles.panel}>
          <h2>API Configuration</h2>
          <div className={styles.formRow}>
            <label htmlFor="api-key" className="text-xs text-[var(--muted)]">
              API Key
            </label>
            <Input
              id="api-key"
              type="password"
              value={settings.apiKey}
              placeholder="sk-or-..."
              onChange={(event) => updateApiKey(event.target.value)}
            />
          </div>
          <div className={`${styles.formRow} ${styles.formInline}`}>
            <Button
              type="button"
              onClick={() => fetchModels(settings.apiKey)}
              disabled={!settings.apiKey || modelsStatus === "loading"}
            >
              {modelsStatus === "loading" ? "Fetching..." : "Fetch Models"}
            </Button>
            <Button
              type="button"
              variant="secondary"
              onClick={() => updateApiKey(settings.apiKey)}
            >
              Save Key
            </Button>
          </div>
          {modelsError && (
            <p className="text-xs text-[var(--danger)]">{modelsError}</p>
          )}
        </div>
      </div>

      <div className={styles.contentRow}>
        <div className={styles.searchColumn}>
          <div className={styles.panel}>
            <h2>Model Selection</h2>
            <p>Select the models you want to compare side-by-side.</p>
            <div className={styles.filtersRow}>
              <div className={styles.filterGroup}>
                <label
                  className="text-xs text-[var(--muted)]"
                  htmlFor="model-search"
                >
                  Search
                </label>
                <Input
                  id="model-search"
                  placeholder="Search by provider, name, or id"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
              <div className={styles.filterGroup}>
                <label
                  className="text-xs text-[var(--muted)]"
                  htmlFor="provider-filter"
                >
                  Provider
                </label>
                <SelectPopover
                  value={providerFilter}
                  onValueChange={setProviderFilter}
                  items={[
                    { value: "all", label: "All providers" },
                    ...providers.map((provider) => ({
                      value: provider,
                      label: provider,
                    })),
                  ]}
                />
              </div>
              <label className={styles.filterGroup}>
                <span className="text-xs text-[var(--muted)]">Show</span>
                <div className="flex flex-wrap gap-3 text-sm">
                  <label className="flex items-center gap-2">
                    <Checkbox
                      checked={showSelectedOnly}
                      onCheckedChange={(value) =>
                        setShowSelectedOnly(Boolean(value))
                      }
                    />
                    Selected only
                  </label>
                </div>
              </label>
              <div className={styles.filterGroup}>
                <span className="text-xs text-[var(--muted)]">Bulk</span>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      setSelectedModels([
                        ...new Set([
                          ...settings.selectedModelIds,
                          ...filteredModels.map((m) => m.id),
                        ]),
                      ])
                    }
                    disabled={filteredModels.length === 0}
                  >
                    Select filtered
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setSelectedModels([])}
                    disabled={settings.selectedModelIds.length === 0}
                  >
                    Clear selection
                  </Button>
                </div>
              </div>
            </div>
            <div className={styles.modelsGrid}>
              {groupedModels.map(([provider, providerModels]) => (
                <div key={provider} className={styles.providerGroup}>
                  <div className={styles.providerHeader}>{provider}</div>
                  <div className={styles.modelsList}>
                    {providerModels.map((model) => {
                      const meta = inferModelCapabilities(model);
                      const capabilities: string[] = [];
                      if (meta.likelyImageInput)
                        capabilities.push("Image Input");
                      if (meta.likelyImageOutput)
                        capabilities.push("Image Output");
                      const maxTokens = model.context_length
                        ? `${(model.context_length / 1000).toFixed(0)}k`
                        : "N/A";

                      return (
                        <label key={model.id} className={styles.modelCard}>
                          <div className={styles.modelCardHeader}>
                            <Checkbox
                              checked={settings.selectedModelIds.includes(
                                model.id,
                              )}
                              onCheckedChange={() =>
                                toggleModelSelection(model.id)
                              }
                            />
                            <div className={styles.modelCardContent}>
                              <div className={styles.modelName}>
                                {model.name}
                              </div>
                              <code className={styles.modelId}>{model.id}</code>
                              <div className={styles.modelMeta}>
                                {capabilities.length > 0 && (
                                  <span className={styles.capabilities}>
                                    {capabilities.join(" • ")}
                                  </span>
                                )}
                                <span className={styles.maxTokens}>
                                  Max: {maxTokens} tokens
                                </span>
                              </div>
                            </div>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))}
              {models.length === 0 && (
                <p className="text-sm text-[var(--muted)]">
                  Fetch models to populate the list.
                </p>
              )}
              {models.length > 0 && filteredModels.length === 0 && (
                <p className="text-sm text-[var(--muted)]">
                  No models match the current filters.
                </p>
              )}
            </div>
          </div>
        </div>
        <div className={styles.selectedColumn}>
          <div className={styles.selectedModelsList}>
            <h2>Selected Models</h2>
            {selectedModelsList.length === 0 ? (
              <p className="text-sm text-[var(--muted)]">
                No models selected. Use the search to find and select models.
              </p>
            ) : (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                onDragEnd={handleDragEnd}
              >
                <SortableContext
                  items={selectedModelsList.map((item) => item.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <div className="flex flex-col gap-2">
                    {selectedModelsList.map((model) => (
                      <SortableModelItem key={model.id} model={model} />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
