import { useState } from "react";
import { useTasks, type Task } from "../store";
import { fileUrl } from "../api";
import { StatusBadge } from "./StatusBadge";
import { EscapeHtml } from "./EscapeHtml";
import { ErrorBanner } from "./ErrorBanner";
import { validateFilename } from "../utils/sanitize";

export function TaskDetail({ task }: { task: Task }) {
  const { cancelTask, deleteTask, downloadVideo } = useTasks();
  const [filename, setFilename] = useState(`${task.id}.mp4`);
  const [localError, setLocalError] = useState<string | null>(null);

  const isTerminal = ["succeeded", "failed", "canceled"].includes(task.status);
  const isSucceeded = task.status === "succeeded";

  const onDownload = async () => {
    setLocalError(null);
    const v = validateFilename(filename.trim() ? filename : `${task.id}.mp4`);
    if (!v.ok) {
      setLocalError(v.error ?? "文件名不合法");
      return;
    }
    await downloadVideo(task.id, v.safeName);
  };

  return (
    <div className="card detail">
      <div className="row between" style={{ alignItems: "center" }}>
        <div>
          <StatusBadge status={task.status} />
          <EscapeHtml as="code" className="taskitem-id" text={task.id} />
        </div>
        <div className="row">
          {!isTerminal && (
            <button className="danger" onClick={() => cancelTask(task.id)}>
              取消
            </button>
          )}
          <button className="danger" onClick={() => deleteTask(task.id)}>
            删除
          </button>
        </div>
      </div>

      {task.error && <ErrorBanner error={task.error} />}
      {localError && (
        <ErrorBanner error={localError} onDismiss={() => setLocalError(null)} />
      )}

      {isSucceeded && task.links.file && (
        <video className="player" src={fileUrl(task.id)} controls />
      )}

      <div className="row" style={{ marginTop: 12 }}>
        <input
          type="text"
          placeholder="下载文件名，例如 hyperframes.mp4"
          value={filename}
          onChange={(e) => setFilename(e.target.value)}
          aria-label="下载文件名"
        />
        <button onClick={onDownload} disabled={!isSucceeded}>
          下载视频
        </button>
      </div>

      {task.logs.length > 0 && (
        <>
          <h3>实时日志</h3>
          <div className="logs">
            {task.logs.map((log, i) => (
              <div key={i}>
                <span className="ts">{log.ts}</span>
                <EscapeHtml text={log.line} />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
