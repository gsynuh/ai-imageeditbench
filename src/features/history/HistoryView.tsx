import { useMemo, useState, useRef } from "react";
import { useStore } from "@nanostores/react";
import styles from "./HistoryView.module.scss";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import {
  $activeSession,
  $history,
  deleteSession,
  exportSession,
  loadSession,
  loadMoreHistory,
  updateSessionTitle,
} from "../../stores/sessionsStore";
import {
  $uiState,
  advanceHistoryOffset,
  resetHistoryPagination,
  setHistoryHasMore,
  setHistorySearch,
} from "../../stores/uiStore";
import { formatDateTime } from "../../lib/utils";
import { Download, Trash2, Upload, Edit2, Check, X } from "lucide-react";
import { setActiveView } from "../../stores/appStore";
import { $models } from "../../stores/modelsStore";
import type { Session } from "../../types/db";

function HistoryItem({
  item,
  onRename,
  models,
}: {
  item: Session;
  onRename: (id: string, title: string) => void;
  models: { id: string; name?: string }[];
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(item.title ?? "");
  const inputRef = useRef<HTMLInputElement>(null);

  const handleStartEdit = () => {
    setEditTitle(item.title ?? "");
    setIsEditing(true);
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const handleSave = () => {
    const trimmed = editTitle.trim();
    onRename(item.id, trimmed);
    setIsEditing(false);
  };

  const handleCancel = () => {
    setEditTitle(item.title ?? "");
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      handleSave();
    } else if (e.key === "Escape") {
      handleCancel();
    }
  };

  return (
    <div className={styles.historyItem}>
      <div className={styles.historyItemContent}>
        {isEditing ? (
          <div className={styles.historyItemEdit}>
            <Input
              ref={inputRef}
              type="text"
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              onKeyDown={handleKeyDown}
              onBlur={handleSave}
              placeholder="Session name..."
              className={styles.historyItemInput}
            />
            <div className={styles.historyItemEditActions}>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleSave}
                title="Save"
              >
                <Check size={14} />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleCancel}
                title="Cancel"
              >
                <X size={14} />
              </Button>
            </div>
          </div>
        ) : (
          <>
            {item.title ? (
              <>
                <div className={styles.historyItemHeader}>
                  <strong>{item.title}</strong>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={handleStartEdit}
                    title="Rename"
                    className={styles.historyItemRename}
                  >
                    <Edit2 size={12} />
                  </Button>
                </div>
                <div className={styles.historyItemMeta}>
                  <div className={styles.historyItemModels}>
                    {item.modelIds.map((modelId) => {
                      const model = models.find((m) => m.id === modelId);
                      return (
                        <code
                          key={modelId}
                          className={styles.historyItemModelId}
                        >
                          {model?.name ?? modelId}
                        </code>
                      );
                    })}
                  </div>
                  <p>
                    {formatDateTime(item.updatedAt)} - {item.messageCount}{" "}
                    messages - $
                    {typeof item.totalCost === "number"
                      ? item.totalCost.toFixed(6)
                      : "0.000000"}
                  </p>
                </div>
              </>
            ) : (
              <>
                <div className={styles.historyItemHeader}>
                  <strong>{formatDateTime(item.updatedAt)}</strong>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={handleStartEdit}
                    title="Add name"
                    className={styles.historyItemRename}
                  >
                    <Edit2 size={12} />
                  </Button>
                </div>
                <div className={styles.historyItemMeta}>
                  <div className={styles.historyItemModels}>
                    {item.modelIds.map((modelId) => {
                      const model = models.find((m) => m.id === modelId);
                      return (
                        <code
                          key={modelId}
                          className={styles.historyItemModelId}
                        >
                          {model?.name ?? modelId}
                        </code>
                      );
                    })}
                  </div>
                  <p>
                    {item.messageCount} messages - $
                    {typeof item.totalCost === "number"
                      ? item.totalCost.toFixed(6)
                      : "0.000000"}
                  </p>
                </div>
              </>
            )}
          </>
        )}
      </div>
      {!isEditing && (
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={async () => {
              await loadSession(item.id);
              setActiveView("session");
            }}
          >
            <Upload size={14} />
            Load
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => exportSession(item.id)}
          >
            <Download size={14} />
            Export
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => deleteSession(item.id)}
          >
            <Trash2 size={14} />
            Delete
          </Button>
        </div>
      )}
    </div>
  );
}

export default function HistoryView() {
  const sessionState = useStore($activeSession);
  const history = useStore($history);
  const models = useStore($models);
  const uiState = useStore($uiState);

  const filteredHistory = useMemo(() => {
    if (!uiState.historySearch.trim()) return history;
    const query = uiState.historySearch.toLowerCase();
    return history.filter(
      (session) =>
        session.id.toLowerCase().includes(query) ||
        session.title?.toLowerCase().includes(query) ||
        session.modelIds.some((id) => id.toLowerCase().includes(query)),
    );
  }, [history, uiState.historySearch]);

  const handleLoadMore = async () => {
    const nextOffset = uiState.historyOffset + 20;
    await loadMoreHistory(nextOffset);
    advanceHistoryOffset(20);
  };

  const handleSearch = (value: string) => {
    setHistorySearch(value);
    resetHistoryPagination();
    if (value.trim() === "") {
      setHistoryHasMore(history.length === 20);
    }
  };

  const handleRename = async (id: string, title: string) => {
    await updateSessionTitle(title, id);
  };

  return (
    <div className={styles.historyView}>
      <div className={styles.panel}>
        <h2>Session History</h2>
        <p>Load, export, rename, or delete saved sessions.</p>
        <div className={styles.historyControls}>
          <div className={styles.historySearch}>
            <label
              className="text-xs text-[var(--muted)]"
              htmlFor="history-search"
            >
              Search
            </label>
            <Input
              id="history-search"
              placeholder="Filter by name, id, or model"
              value={uiState.historySearch}
              onChange={(event) => handleSearch(event.target.value)}
            />
          </div>
        </div>
        <div className={styles.historyList}>
          {filteredHistory.map((item) => (
            <HistoryItem
              key={item.id}
              item={item}
              onRename={handleRename}
              models={models}
            />
          ))}
          {filteredHistory.length === 0 && (
            <div className={`${styles.historyItem} ${styles.historyItemMuted}`}>
              <div>
                <strong>No saved sessions yet</strong>
                <p>Run a session to populate history.</p>
              </div>
            </div>
          )}
        </div>
        {uiState.historyHasMore && (
          <Button type="button" variant="secondary" onClick={handleLoadMore}>
            Load more
          </Button>
        )}
        {sessionState.session && (
          <p className="text-xs text-[var(--muted)]">
            Active session: {sessionState.session.id}
          </p>
        )}
      </div>
    </div>
  );
}
