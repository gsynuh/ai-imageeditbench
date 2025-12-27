import { useMemo } from "react";
import { useStore } from "@nanostores/react";
import styles from "./StatsView.module.scss";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import {
  $activeConversation,
  $history,
  deleteConversation,
  exportConversation,
  loadConversation,
  loadMoreHistory,
} from "../../stores/conversationsStore";
import { $models } from "../../stores/modelsStore";
import {
  $uiState,
  advanceHistoryOffset,
  resetHistoryPagination,
  setHistoryHasMore,
  setHistorySearch,
} from "../../stores/uiStore";
import { formatDateTime } from "../../lib/utils";
import { Download, Trash2, Upload } from "lucide-react";
import { setActiveView } from "../../stores/appStore";

export default function StatsView() {
  const conversationState = useStore($activeConversation);
  const history = useStore($history);
  const models = useStore($models);
  const uiState = useStore($uiState);

  const statsList = useMemo(() => {
    const entries = Object.values(conversationState.statsByModel ?? {});
    return entries.map((stat) => {
      const model = models.find((item) => item.id === stat.modelId);
      return { ...stat, modelName: model?.name ?? stat.modelId };
    });
  }, [conversationState.statsByModel, models]);

  const filteredHistory = useMemo(() => {
    if (!uiState.historySearch.trim()) return history;
    const query = uiState.historySearch.toLowerCase();
    return history.filter(
      (conversation) =>
        conversation.id.toLowerCase().includes(query) ||
        conversation.modelIds.some((id) => id.toLowerCase().includes(query)),
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

  return (
    <div className={styles.statsView}>
      <div className={styles.panel}>
        <h2>Token Usage</h2>
        <p>Track inputs vs outputs per model and per conversation.</p>
        <div className={styles.statList}>
          {statsList.length === 0 && (
            <p className="text-sm text-[var(--muted)]">
              Run a benchmark to populate token usage stats.
            </p>
          )}
          {statsList.map((stat) => (
            <div className={styles.statRow} key={stat.modelId}>
              <span>{stat.modelName}</span>
              <span>
                {stat.inputTokens} in - {stat.outputTokens} out
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className={styles.panel}>
        <h2>Cost Tracking</h2>
        <p>Compare total costs and drill into message-level spend.</p>
        <div className={styles.statList}>
          {statsList.map((stat) => (
            <div className={styles.statRow} key={`${stat.modelId}-cost`}>
              <span>{stat.modelName}</span>
              <span>
                $
                {typeof stat.totalCost === "number"
                  ? stat.totalCost.toFixed(6)
                  : "0.000000"}
              </span>
            </div>
          ))}
          {statsList.length === 0 && (
            <p className="text-sm text-[var(--muted)]">
              Costs will appear once completions are run.
            </p>
          )}
        </div>
      </div>

      <div className={`${styles.panel} ${styles.panelWide}`}>
        <h2>Conversation History</h2>
        <p>Load, export, or delete saved benchmarks from IndexedDB.</p>
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
              placeholder="Filter by id or model"
              value={uiState.historySearch}
              onChange={(event) => handleSearch(event.target.value)}
            />
          </div>
        </div>
        <div className={styles.historyList}>
          {filteredHistory.map((item) => (
            <div className={styles.historyItem} key={item.id}>
              <div>
                <strong>
                  {formatDateTime(item.updatedAt)} - {item.modelIds.length}{" "}
                  models
                </strong>
                <p>
                  {item.messageCount} messages - $
                  {typeof item.totalCost === "number"
                    ? item.totalCost.toFixed(6)
                    : "0.000000"}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={async () => {
                    await loadConversation(item.id);
                    setActiveView("main");
                  }}
                >
                  <Upload size={14} />
                  Load
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => exportConversation(item.id)}
                >
                  <Download size={14} />
                  Export
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => deleteConversation(item.id)}
                >
                  <Trash2 size={14} />
                  Delete
                </Button>
              </div>
            </div>
          ))}
          {filteredHistory.length === 0 && (
            <div className={`${styles.historyItem} ${styles.historyItemMuted}`}>
              <div>
                <strong>No saved conversations yet</strong>
                <p>Run a benchmark to populate history.</p>
              </div>
            </div>
          )}
        </div>
        {uiState.historyHasMore && (
          <Button type="button" variant="secondary" onClick={handleLoadMore}>
            Load more
          </Button>
        )}
        {conversationState.conversation && (
          <p className="text-xs text-[var(--muted)]">
            Active conversation: {conversationState.conversation.id}
          </p>
        )}
      </div>
    </div>
  );
}
