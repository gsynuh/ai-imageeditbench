import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "@nanostores/react";
import type { Message, SessionStats } from "../../../types/db";
import styles from "../SessionView.module.scss";
import { Button } from "../../../components/ui/button";
import {
  abortStream,
  removeMessageFromModel,
  rerunLastAssistantMessage,
} from "../../../stores/sessionsStore";
import MessageCard from "./MessageCard";
import { Ban, Circle, CircleDot, RotateCcw } from "lucide-react";
import { getImage } from "../../../lib/idb";
import { ScrollArea } from "../../../components/ui/scroll-area";
import ImageViewer from "./ImageViewer";
import { $uiState, toggleSoloModel } from "../../../stores/uiStore";

export default function ModelColumn({
  modelId,
  modelName,
  messages,
  stats,
  isStreaming,
}: {
  modelId: string;
  modelName: string;
  messages: Message[];
  stats?: SessionStats;
  isStreaming?: boolean;
}) {
  const [imageUrls, setImageUrls] = useState<
    Record<string, Array<{ id: string; url: string }>>
  >({});
  const urlsRef = useRef<Record<string, Array<{ id: string; url: string }>>>(
    {},
  );
  const [viewerImageId, setViewerImageId] = useState<string | null>(null);
  const [activeRunIndex, setActiveRunIndex] = useState<number | undefined>(
    undefined,
  );
  const uiState = useStore($uiState);
  const isSolo = uiState.soloModelIds.has(modelId);
  const hasAnySolo = uiState.soloModelIds.size > 0;
  const shouldDim = hasAnySolo && !isSolo;

  const runs = useMemo(() => {
    const runMap = new Map<number, Message[]>();

    // Group messages by runIndex - each run has its own copies
    messages.forEach((msg) => {
      if (msg.runIndex === undefined) {
        // Legacy messages without runIndex - skip or handle separately
        // In the new model, all messages should have runIndex
        return;
      }
      if (!runMap.has(msg.runIndex)) runMap.set(msg.runIndex, []);
      runMap.get(msg.runIndex)!.push(msg);
    });

    // Sort messages within each run: system messages first, then by createdAt
    runMap.forEach((runMessages) => {
      runMessages.sort((a, b) => {
        // System messages first
        if (a.role === "system" && b.role !== "system") return -1;
        if (a.role !== "system" && b.role === "system") return 1;
        // Then sort by createdAt
        return a.createdAt - b.createdAt;
      });
    });

    return Array.from(runMap.entries()).sort(([a], [b]) => a - b);
  }, [messages]);

  // Default to latest run when multiple runs exist - compute default in useMemo
  const defaultRunIndex = useMemo(() => {
    if (runs.length > 1) {
      const latestRun = runs[runs.length - 1];
      return latestRun ? latestRun[0] : undefined;
    }
    return undefined;
  }, [runs]);

  const displayMessages = useMemo(() => {
    if (runs.length === 0) {
      // No runs yet - show messages without runIndex (legacy) or empty
      const legacyMessages = messages.filter(
        (msg) => msg.runIndex === undefined,
      );
      return legacyMessages.sort((a, b) => {
        // System messages first
        if (a.role === "system" && b.role !== "system") return -1;
        if (a.role !== "system" && b.role === "system") return 1;
        // Then sort by createdAt
        return a.createdAt - b.createdAt;
      });
    }
    if (runs.length === 1) {
      // Single run - show its messages
      return runs[0][1];
    }
    // Multiple runs - show selected run
    const runIndexToUse = activeRunIndex ?? defaultRunIndex;
    if (runIndexToUse === undefined) return [];
    const run = runs.find(([runIdx]) => runIdx === runIndexToUse);
    return run ? run[1] : [];
  }, [runs, activeRunIndex, defaultRunIndex, messages]);

  useEffect(() => {
    let active = true;
    const loadImages = async () => {
      try {
        const map: Record<string, Array<{ id: string; url: string }>> = {};
        // Track seen image hashes per message to prevent duplicates within a message
        // But allow the same image to appear in different messages/runs

        for (const message of displayMessages) {
          const urls: Array<{ id: string; url: string }> = [];

          for (const imageId of message.imageIds) {
            try {
              const asset = await getImage(imageId);
              if (!asset) continue;
              const url = URL.createObjectURL(asset.blob);
              urls.push({ id: imageId, url });
            } catch (error) {
              if (import.meta.env.DEV) {
                console.error(
                  `[ModelColumn] Error loading image ${imageId}:`,
                  error,
                );
              }
            }
          }
          map[message.id] = urls;
        }
        if (active) {
          setImageUrls((prev) => {
            Object.values(prev)
              .flat()
              .forEach((item) => URL.revokeObjectURL(item.url));
            return map;
          });
          urlsRef.current = map;
        }
      } catch (error) {
        if (import.meta.env.DEV) {
          console.error("[ModelColumn] Error loading images:", error);
        }
      }
    };
    void loadImages();
    return () => {
      active = false;
      Object.values(urlsRef.current)
        .flat()
        .forEach((item) => URL.revokeObjectURL(item.url));
    };
  }, [displayMessages]);

  return (
    <div className={styles.columnCard} style={{ opacity: shouldDim ? 0.5 : 1 }}>
      <ImageViewer
        open={Boolean(viewerImageId)}
        imageId={viewerImageId}
        onClose={() => setViewerImageId(null)}
      />
      <div className={styles.columnHeader}>
        <div>
          <h3 className="text-sm font-bold">{modelName}</h3>
          {runs.length > 1 && (
            <div className="flex gap-2 mt-2">
              {runs.map(([runIdx]) => (
                <button
                  key={runIdx}
                  type="button"
                  onClick={() => setActiveRunIndex(runIdx)}
                  className={`text-xs px-2 py-1 rounded ${
                    activeRunIndex === runIdx ||
                    (activeRunIndex === undefined && runIdx === defaultRunIndex)
                      ? "bg-white/10 border border-white/20"
                      : "bg-white/5 border border-transparent hover:bg-white/8"
                  }`}
                >
                  Run {runIdx}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            variant={isSolo ? "secondary" : "ghost"}
            size="sm"
            onClick={() => toggleSoloModel(modelId)}
            title={
              isSolo
                ? "Solo mode: only this model will receive messages"
                : "Enable solo mode for this model"
            }
          >
            {isSolo ? <CircleDot size={16} /> : <Circle size={16} />}
          </Button>
          {!isStreaming &&
            displayMessages.length > 0 &&
            displayMessages[displayMessages.length - 1]?.role !==
              "assistant" && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={async () => {
                  try {
                    await rerunLastAssistantMessage(modelId);
                  } catch (error) {
                    if (import.meta.env.DEV) {
                      console.error(
                        "[ModelColumn] Error re-running message:",
                        error,
                      );
                    }
                  }
                }}
                title="Re-run last assistant response"
              >
                <RotateCcw size={16} />
                Re-run
              </Button>
            )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={async () => {
              try {
                // If a specific run is active, abort only that run
                // Otherwise abort all runs for this model
                await abortStream(modelId, activeRunIndex);
              } catch (error) {
                if (import.meta.env.DEV) {
                  console.error("[ModelColumn] Error aborting stream:", error);
                }
              }
            }}
            disabled={!isStreaming}
          >
            <Ban size={16} />
            Abort
          </Button>
        </div>
      </div>
      <ScrollArea className={styles.messageStack}>
        <div className="flex flex-col gap-2">
          {displayMessages.map((message) => (
            <MessageCard
              key={message.id}
              message={message}
              images={imageUrls[message.id] ?? []}
              onRemove={async () => {
                try {
                  // Pass the active runIndex so we only delete messages for that run
                  // If no runIndex is active, delete normally (for single-run case)
                  await removeMessageFromModel(
                    modelId,
                    message.id,
                    activeRunIndex,
                  );
                } catch (error) {
                  if (import.meta.env.DEV) {
                    console.error(
                      "[ModelColumn] Error removing message:",
                      error,
                    );
                  }
                }
              }}
              onOpenImage={(imageId) => setViewerImageId(imageId)}
            />
          ))}
        </div>
      </ScrollArea>
      <div className={styles.columnFooter}>
        <span>
          Tokens: {stats?.inputTokens ?? 0} in / {stats?.outputTokens ?? 0} out
          - Cost: $
          {typeof stats?.totalCost === "number"
            ? stats.totalCost.toFixed(6)
            : "0.000000"}
        </span>
      </div>
    </div>
  );
}
