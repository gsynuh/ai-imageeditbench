import { useEffect } from "react";
import { useStore } from "@nanostores/react";
import styles from "./MainView.module.scss";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import { Button } from "../../components/ui/button";
import {
  $activeConversation,
  resetConversation,
} from "../../stores/conversationsStore";
import { $models } from "../../stores/modelsStore";
import { $settings, moveSelectedModel } from "../../stores/settingsStore";
import { setActiveView } from "../../stores/appStore";
import ModelColumn from "./components/ModelColumn";
import InputDock from "./components/InputDock";
import { History, RotateCcw, ArrowLeft, ArrowRight, Dot } from "lucide-react";
import {
  setHeaderCenter,
  setHeaderRightActions,
  type HeaderAction,
} from "../../stores/headerStore";

function getMainViewHeaderActions(): HeaderAction[] {
  return [
    {
      key: "clear-board",
      label: "Clear Board",
      icon: RotateCcw,
      onClick: resetConversation,
      variant: "secondary",
    },
    {
      key: "open-history",
      label: "Open History",
      icon: History,
      onClick: () => setActiveView("stats"),
      variant: "secondary",
    },
  ];
}

export default function MainView() {
  const conversationState = useStore($activeConversation);
  const models = useStore($models);
  const settings = useStore($settings);

  const activeModels = settings.selectedModelIds;

  useEffect(() => {
    setHeaderRightActions(getMainViewHeaderActions());
    return () => {
      setHeaderCenter(null);
      setHeaderRightActions([]);
    };
  }, []);

  return (
    <div className={styles.mainView}>
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
            const messages = conversationState.messagesByModel[modelId] ?? [];
            const stats = conversationState.statsByModel[modelId];
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
                  isStreaming={conversationState.streamingByModel[modelId]}
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
