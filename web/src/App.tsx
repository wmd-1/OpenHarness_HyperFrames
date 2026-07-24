import { useEffect } from "react";
import { TasksProvider, useTasks } from "./store";
import { Composer } from "./components/Composer";
import { TaskList } from "./components/TaskList";
import { TaskDetail } from "./components/TaskDetail";
import { HealthBadge } from "./components/HealthBadge";
import { ErrorBanner } from "./components/ErrorBanner";

function Shell() {
  const {
    tasks,
    selectedId,
    selectedTask,
    selectTask,
    error,
    clearError,
  } = useTasks();

  // Auto-dismiss the global error banner after a while so it does not linger.
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => clearError(), 8000);
    return () => clearTimeout(t);
  }, [error, clearError]);

  return (
    <div className="app">
      <div className="topbar">
        <h1>OpenHarness · HyperFrames</h1>
        <HealthBadge />
      </div>

      {error && <ErrorBanner error={error} onDismiss={clearError} />}

      <div className="layout">
        <div className="sidebar">
          <Composer />
          <div className="card">
            <h3>任务列表</h3>
            <TaskList
              tasks={tasks}
              selectedId={selectedId}
              onSelect={selectTask}
            />
          </div>
        </div>
        <div className="detail">
          {selectedTask ? (
            <TaskDetail task={selectedTask} />
          ) : (
            <p className="empty">选择左侧任务查看详情，或提交一个新的 prompt。</p>
          )}
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <TasksProvider>
      <Shell />
    </TasksProvider>
  );
}
