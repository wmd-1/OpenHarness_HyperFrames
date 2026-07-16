import { useCallback, useEffect, useRef, useState } from "react";
import {
  createVideo,
  deleteVideo,
  eventsUrl,
  fileUrl,
  getVideo,
  getHealth,
} from "./api";
import type { TaskStatus, VideoTaskResponse } from "./types";

const TERMINAL: TaskStatus[] = ["SUCCEEDED", "FAILED", "CANCELED"];

interface LogLine {
  t: string;
  msg: string;
}

export default function App() {
  const [prompt, setPrompt] = useState("");
  const [timeoutSeconds, setTimeoutSeconds] = useState(600);
  const [idempotencyKey, setIdempotencyKey] = useState("");

  const [task, setTask] = useState<VideoTaskResponse | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<string>("?");

  const esRef = useRef<EventSource | null>(null);
  const pollRef = useRef<number | null>(null);

  const stopStreams = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    if (pollRef.current !== null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => stopStreams();
  }, [stopStreams]);

  useEffect(() => {
    getHealth()
      .then((h) => setHealth(h.status))
      .catch(() => setHealth("down"));
  }, []);

  const handleCreate = useCallback(async () => {
    if (!prompt.trim()) {
      setError("请输入 prompt");
      return;
    }
    setBusy(true);
    setError(null);
    setLogs([]);
    setTask(null);
    try {
      const res = await createVideo(
        prompt.trim(),
        timeoutSeconds,
        [],
        idempotencyKey.trim() || undefined
      );
      setTask({
        task_id: res.task_id,
        status: res.status,
        links: res.links,
      });
      const es = new EventSource(eventsUrl(res.task_id));
      esRef.current = es;
      es.addEventListener("log", (e) => {
        const data = (e as MessageEvent).data;
        setLogs((prev) => [
          ...prev,
          { t: new Date().toLocaleTimeString(), msg: data },
        ]);
      });
      es.addEventListener("done", () => {
        es.close();
        esRef.current = null;
      });
      es.addEventListener("error", (e) => {
        const data = (e as MessageEvent).data;
        if (data) setError(data);
        es.close();
        esRef.current = null;
      });
      pollRef.current = window.setInterval(async () => {
        try {
          const v = await getVideo(res.task_id);
          setTask(v);
          if (TERMINAL.includes(v.status)) {
            stopStreams();
          }
        } catch (err) {
          setError(String(err));
        }
      }, 2000);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }, [prompt, timeoutSeconds, idempotencyKey, stopStreams]);

  const handleDelete = useCallback(async () => {
    if (!task) return;
    stopStreams();
    setBusy(true);
    try {
      await deleteVideo(task.task_id);
      setTask(null);
      setLogs([]);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }, [task, stopStreams]);

  return (
    <div className="app">
      <header className="topbar">
        <h1>HyperFrames 视频工厂</h1>
        <span className={"health " + (health === "ok" ? "ok" : "bad")}>
          API: {health}
        </span>
      </header>

      <section className="card">
        <label>Prompt</label>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={4}
          placeholder="描述你想生成的视频…"
        />
        <div className="row">
          <div className="field">
            <label>超时(秒)</label>
            <input
              type="number"
              value={timeoutSeconds}
              onChange={(e) => setTimeoutSeconds(Number(e.target.value))}
            />
          </div>
          <div className="field">
            <label>幂等键(可选)</label>
            <input
              value={idempotencyKey}
              onChange={(e) => setIdempotencyKey(e.target.value)}
              placeholder="idempotency_key"
            />
          </div>
        </div>
        <div className="row">
          <button onClick={handleCreate} disabled={busy || !prompt.trim()}>
            {busy ? "提交中…" : "生成视频"}
          </button>
          {task && (
            <button className="danger" onClick={handleDelete} disabled={busy}>
              删除任务
            </button>
          )}
        </div>
      </section>

      {error && <div className="error">⚠ {error}</div>}

      {task && (
        <section className="card">
          <div className="row between">
            <h2>任务 {task.task_id}</h2>
            <span className={"status " + task.status.toLowerCase()}>
              {task.status}
            </span>
          </div>
          {task.error && <div className="error">{task.error}</div>}
          {task.status === "SUCCEEDED" && (
            <video src={fileUrl(task.task_id)} controls className="player" />
          )}
        </section>
      )}

      {logs.length > 0 && (
        <section className="card">
          <h2>日志</h2>
          <pre className="logs">
            {logs.map((l, i) => (
              <div key={i}>
                <span className="ts">[{l.t}]</span> {l.msg}
              </div>
            ))}
          </pre>
        </section>
      )}
    </div>
  );
}
