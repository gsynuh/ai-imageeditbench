import { useMemo, useEffect, useState } from "react";
import { useStore } from "@nanostores/react";
import styles from "./StatsView.module.scss";
import { $activeSession, $history } from "../../stores/sessionsStore";
import { $models } from "../../stores/modelsStore";
import { getAllStats } from "../../lib/idb";
import type { SessionStats } from "../../types/db";

export default function StatsView() {
  const sessionState = useStore($activeSession);
  const history = useStore($history);
  const models = useStore($models);
  const [allStats, setAllStats] = useState<SessionStats[]>([]);

  // Load all stats from IndexedDB on mount and when history or active session changes
  useEffect(() => {
    const loadStats = async () => {
      const stats = await getAllStats();
      setAllStats(stats);
    };
    void loadStats();
  }, [history, sessionState.session?.id]);

  // Aggregate stats by modelId across all sessions
  const aggregatedStats = useMemo(() => {
    const byModel = new Map<string, SessionStats>();
    for (const stat of allStats) {
      const existing = byModel.get(stat.modelId);
      if (existing) {
        existing.inputTokens += stat.inputTokens;
        existing.outputTokens += stat.outputTokens;
        existing.totalCost += stat.totalCost;
      } else {
        byModel.set(stat.modelId, {
          sessionId: "", // Not meaningful for aggregated stats
          modelId: stat.modelId,
          inputTokens: stat.inputTokens,
          outputTokens: stat.outputTokens,
          totalCost: stat.totalCost,
        });
      }
    }
    return Array.from(byModel.values());
  }, [allStats]);

  const statsList = useMemo(() => {
    return aggregatedStats.map((stat) => {
      const model = models.find((item) => item.id === stat.modelId);
      return { ...stat, modelName: model?.name ?? stat.modelId };
    });
  }, [aggregatedStats, models]);

  // Calculate totals across all models
  const totals = useMemo(() => {
    return statsList.reduce(
      (acc, stat) => {
        acc.inputTokens += stat.inputTokens;
        acc.outputTokens += stat.outputTokens;
        acc.totalCost += stat.totalCost;
        return acc;
      },
      { inputTokens: 0, outputTokens: 0, totalCost: 0 },
    );
  }, [statsList]);

  return (
    <div className={styles.statsView}>
      <div className={styles.panel}>
        <h2>Token Usage</h2>
        <p>Track inputs vs outputs per model and per session.</p>
        <div className={styles.statList}>
          {statsList.length === 0 && (
            <p className="text-sm text-[var(--muted)]">
              Run a session to populate token usage stats.
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
          {statsList.length > 0 && (
            <div className={`${styles.statRow} ${styles.statRowTotal}`}>
              <span>
                <strong>Total</strong>
              </span>
              <span>
                <strong>
                  {totals.inputTokens} in - {totals.outputTokens} out
                </strong>
              </span>
            </div>
          )}
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
          {statsList.length > 0 && (
            <div className={`${styles.statRow} ${styles.statRowTotal}`}>
              <span>
                <strong>Total</strong>
              </span>
              <span>
                <strong>
                  $
                  {typeof totals.totalCost === "number"
                    ? totals.totalCost.toFixed(6)
                    : "0.000000"}
                </strong>
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
