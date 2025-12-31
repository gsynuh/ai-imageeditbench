import { useEffect, useState, useRef } from "react";
import { useStore } from "@nanostores/react";
import styles from "./SessionView.module.scss";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  $activeSession,
  resetSession,
  updateSessionTitle,
} from "@stores/sessionsStore";
import { $models } from "@stores/modelsStore";
import { $settings, moveSelectedModel } from "@stores/settingsStore";
import ModelColumn from "@features/session/components/ModelColumn";
import InputDock from "@features/session/components/InputDock";
import { RotateCcw, ArrowLeft, ArrowRight, Dot } from "lucide-react";
import {
  setHeaderCenter,
  setHeaderRightActions,
  type HeaderAction,
} from "@stores/headerStore";

function getSessionViewHeaderActions(): HeaderAction[] {
  return [
    {
      key: "clear-session",
      label: "New Session",
      icon: RotateCcw,
      onClick: resetSession,
      variant: "secondary",
    },
  ];
}

function SessionTitleInput() {
  const sessionState = useStore($activeSession);
  const sessionId = sessionState.session?.id;
  const savedTitle = sessionState.session?.title ?? "";
  const [localTitle, setLocalTitle] = useState<string>("");
  const prevSessionIdRef = useRef<string | undefined>(sessionId);

  // Reset local title when session changes
  if (prevSessionIdRef.current !== sessionId) {
    prevSessionIdRef.current = sessionId;
    setLocalTitle("");
  }

  // Use local title if it's been set, otherwise use saved title
  const displayTitle = localTitle || savedTitle;

  const handleChange = (value: string) => {
    setLocalTitle(value);
  };

  const handleBlur = () => {
    const finalTitle = localTitle || savedTitle;
    setLocalTitle("");
    void updateSessionTitle(finalTitle);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.currentTarget.blur();
    }
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "8px",
        minWidth: "200px",
        maxWidth: "400px",
      }}
    >
      <Input
        type="text"
        placeholder="Session name..."
        value={displayTitle}
        onChange={(e) => handleChange(e.target.value)}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        style={{ fontSize: "0.9rem" }}
      />
    </div>
  );
}

export default function SessionView() {
  const sessionState = useStore($activeSession);
  const models = useStore($models);
  const settings = useStore($settings);

  const activeModels = settings.selectedModelIds;

  useEffect(() => {
    setHeaderRightActions(getSessionViewHeaderActions());
    setHeaderCenter(<SessionTitleInput />);
    return () => {
      setHeaderCenter(null);
      setHeaderRightActions([]);
    };
  }, []);

  return (
    <div className={styles.sessionView}>
      <div className={styles.columnsSection}>
        {activeModels.length > 0 && (
          <div className={styles.columnControls}>
            {activeModels.map((modelId, index) => {
              const canMoveLeft = index > 0;
              const canMoveRight = index < activeModels.length - 1;
              return (
                <div key={modelId} className={styles.columnControlGroup}>
                  {index > 0 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={!canMoveLeft}
                      onClick={async () => {
                        await moveSelectedModel(modelId, -1);
                      }}
                      title="Move column left"
                    >
                      <ArrowLeft size={16} />
                    </Button>
                  )}
                  {index > 0 && index < activeModels.length - 1 && (
                    <Dot size={18} className={styles.controlSeparator} />
                  )}
                  {index < activeModels.length - 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={!canMoveRight}
                      onClick={async () => {
                        await moveSelectedModel(modelId, 1);
                      }}
                      title="Move column right"
                    >
                      <ArrowRight size={16} />
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <div className={styles.columnsGrid}>
          {activeModels.map((modelId) => {
            const modelInfo = models.find((model) => model.id === modelId);
            const messages = sessionState.messagesByModel[modelId] ?? [];
            const stats = sessionState.statsByModel[modelId];
            return (
              <ErrorBoundary
                key={modelId}
                fallback={
                  <div className={styles.columnCard}>
                    <h3>{modelInfo?.name ?? modelId}</h3>
                    <p className="text-sm text-[var(--danger)]">
                      Error loading this model column
                    </p>
                  </div>
                }
              >
                <ModelColumn
                  modelId={modelId}
                  modelName={modelInfo?.name ?? modelId}
                  messages={messages}
                  stats={stats}
                  isStreaming={sessionState.streamingByModel[modelId]}
                />
              </ErrorBoundary>
            );
          })}
          {activeModels.length === 0 && (
            <div className={styles.columnCard}>
              <h3>Select models to begin</h3>
              <p className="text-sm text-[var(--muted)]">
                Head to Settings to pick OpenRouter models and configure their
                parameters.
              </p>
            </div>
          )}
        </div>
      </div>

      <InputDock />
    </div>
  );
}
