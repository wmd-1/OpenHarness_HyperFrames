import { useTasks } from "../store";
import { StatusBadge } from "./StatusBadge";

const TERMINAL = ["succeeded", "failed", "canceled"];

export function TaskDetail() {
  const { activeId, tasks, order, logs, remove, error, clearError, fileUrlFor } =
    useTasks();

  if (order.length === 0) {
    return (
      <div className="card empty">
        暂无任务。在左侧提交一个 prompt 开始生成视频。
      </div>
    );
  }
  if (!activeId) {
    return <div className="card empty">选择一个任务查看详情。</div>;
  }
  const task = tasks[activeId];
  if (!task) {
    return <div className="card empty">任务不存在或已被删除。</div>;
  }

  const terminal = TERMINAL.includes(task.status);
  const lines = logs[activeId] ?? [];

  return (
    <div className="card">
      <div className="row between">
        <h2>任务 {activeId.slice(0, 8)}</h2>
        <StatusBadge status={task.status} />
      </div>
      {error && (
        <div className="error" onClick={clearError} role="alert">
          ⚠ {error}
        </div>
      )}
      {task.error && <div className="error">{task.error}</div>}
      {task.status === "succeeded" && (
        <video src={fileUrlFor(activeId)} controls className="player" />
      )}
      <div className="row">
        <button className="danger" onClick={() => void remove(activeId)}>
          {terminal ? "删除任务" : "取消任务"}
        </button>
      </div>
      {lines.length > 0 && (
        <>
          <h3>日志</h3>
          <pre className="logs">
            {lines.map((l, i) => (
              <div key={i}>
                <span className="ts">[{l.t}]</span> {l.msg}
              </div>
            ))}
          </pre>
        </>
      )}
    </div>
  );
}
