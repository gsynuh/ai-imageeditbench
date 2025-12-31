import { useEffect } from "react";
import { useStore } from "@nanostores/react";
import styles from "./App.module.scss";
import { Button } from "@components/ui/button";
import { ErrorBoundary } from "@components/ErrorBoundary";
import { $activeView, setActiveView } from "@stores/appStore";
import {
  ensureSessionLoaded,
  loadHistory,
  syncSessionModels,
} from "@stores/sessionsStore";
import { $settings, loadSettings } from "@stores/settingsStore";
import { loadStoredModels } from "@stores/modelsStore";
import { loadDefaults } from "@stores/defaultsStore";
import { pruneSoloModels } from "@stores/uiStore";
import SessionView from "./features/session/SessionView";
import ModelsView from "./features/models/ModelsView";
import StatsView from "./features/stats/StatsView";
import DefaultsView from "./features/defaults/DefaultsView";
import HistoryView from "./features/history/HistoryView";
import { $headerCenter, $headerRightActions } from "@stores/headerStore";
import VerificationDialog from "@components/VerificationDialog";
import Notifications from "@components/Notifications";

function App() {
  const activeView = useStore($activeView);
  const settings = useStore($settings);
  const headerCenter = useStore($headerCenter);
  const headerRightActions = useStore($headerRightActions);

  useEffect(() => {
    void (async () => {
      await loadSettings();
      await loadStoredModels();
      await loadDefaults();
      await ensureSessionLoaded();
      await loadHistory();
    })();
  }, []);

  useEffect(() => {
    pruneSoloModels(settings.selectedModelIds);
    void syncSessionModels(settings.selectedModelIds);
  }, [settings.selectedModelIds]);

  return (
    <div className={styles.appShell}>
      <header className={styles.appHeader}>
        <div className={styles.headerLeft}>
          <h1 className={styles.appTitle}>S/B/S</h1>

          <nav className={styles.viewTabs} aria-label="Primary views">
            <Button
              variant={activeView === "session" ? "default" : "secondary"}
              onClick={() => setActiveView("session")}
              type="button"
            >
              Session
            </Button>
            <Button
              variant={activeView === "models" ? "default" : "secondary"}
              onClick={() => setActiveView("models")}
              type="button"
            >
              Models
            </Button>
            <Button
              variant={activeView === "defaults" ? "default" : "secondary"}
              onClick={() => setActiveView("defaults")}
              type="button"
            >
              Settings
            </Button>
            <Button
              variant={activeView === "history" ? "default" : "secondary"}
              onClick={() => setActiveView("history")}
              type="button"
            >
              History
            </Button>
            <Button
              variant={activeView === "stats" ? "default" : "secondary"}
              onClick={() => setActiveView("stats")}
              type="button"
            >
              Stats
            </Button>
          </nav>
        </div>

        <div className={styles.headerCenter}>{headerCenter}</div>

        <div className={styles.headerRight}>
          {headerRightActions.map((action) => (
            <Button
              key={action.key}
              type="button"
              variant={action.variant ?? "secondary"}
              size={action.size ?? "md"}
              onClick={() => void action.onClick()}
              disabled={action.disabled}
              title={action.title}
            >
              {action.icon ? <action.icon size={16} /> : null}
              {action.label}
            </Button>
          ))}
        </div>
      </header>

      <section className={styles.viewContainer}>
        {activeView === "session" && (
          <ErrorBoundary>
            <SessionView />
          </ErrorBoundary>
        )}
        {activeView === "models" && (
          <ErrorBoundary>
            <ModelsView />
          </ErrorBoundary>
        )}
        {activeView === "defaults" && (
          <ErrorBoundary>
            <DefaultsView />
          </ErrorBoundary>
        )}
        {activeView === "history" && (
          <ErrorBoundary>
            <HistoryView />
          </ErrorBoundary>
        )}
        {activeView === "stats" && (
          <ErrorBoundary>
            <StatsView />
          </ErrorBoundary>
        )}
      </section>
      <VerificationDialog />
      <Notifications />
    </div>
  );
}

export default App;
