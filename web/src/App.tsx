import { TasksProvider } from "./store";
import { Composer } from "./components/Composer";
import { TaskList } from "./components/TaskList";
import { TaskDetail } from "./components/TaskDetail";
import { HealthBadge } from "./components/HealthBadge";
import { ApiKeyInput } from "./components/ApiKeyInput";

export default function App() {
  return (
    <TasksProvider>
      <div className="app">
        <header className="topbar">
          <h1>HyperFrames 视频工厂</h1>
          <HealthBadge />
        </header>
        <div className="layout">
          <aside className="sidebar">
            <ApiKeyInput />
            <Composer />
            <TaskList />
          </aside>
          <main className="detail">
            <TaskDetail />
          </main>
        </div>
      </div>
    </TasksProvider>
  );
}
