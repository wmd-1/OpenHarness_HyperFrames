import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  createVideo,
  deleteVideo,
  eventsUrl,
  fileUrl,
  getHealth,
  getVideo,
} from "./api";
import type { TaskStatus, VideoTaskResponse } from "./types";

const TERMINAL: TaskStatus[] = ["succeeded", "failed", "canceled"];

export interface LogLine {
  t: string;
  msg: string;
}

interface StreamHandles {
  es: EventSource | null;
  poll: number | null;
}

export interface CreateInput {
  prompt: string;
  timeoutSeconds: number;
  idempotencyKey?: string;
}

interface TasksContextValue {
  tasks: Record<string, VideoTaskResponse>;
  order: string[];
  logs: Record<string, LogLine[]>;
  activeId: string | null;
  error: string | null;
  health: string;
  busy: boolean;
  create: (input: CreateInput) => Promise<void>;
  select: (id: string) => void;
  remove: (id: string) => Promise<void>;
  fileUrlFor: (id: string) => string;
  clearError: () => void;
}

const TasksContext = createContext<TasksContextValue | null>(null);

export function useTasks(): TasksContextValue {
  const ctx = useContext(TasksContext);
  if (!ctx) throw new Error("useTasks must be used within <TasksProvider>");
  return ctx;
}

export function TasksProvider({ children }: { children: ReactNode }) {
  const [tasks, setTasks] = useState<Record<string, VideoTaskResponse>>({});
  const [order, setOrder] = useState<string[]>([]);
  const [logs, setLogs] = useState<Record<string, LogLine[]>>({});
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<string>("?");
  const [busy, setBusy] = useState(false);

  const streams = useRef<Record<string, StreamHandles>>({});

  const stopStreams = useCallback((id: string) => {
    const h = streams.current[id];
    if (!h) return;
    if (h.es) h.es.close();
    if (h.poll !== null) window.clearInterval(h.poll);
    delete streams.current[id];
  }, []);

  const stopAll = useCallback(() => {
    Object.keys(streams.current).forEach(stopStreams);
  }, [stopStreams]);

  useEffect(() => {
    getHealth()
      .then((h) => setHealth(h.status))
      .catch(() => setHealth("down"));
  }, []);

  useEffect(() => () => stopAll(), [stopAll]);

  const startStreams = useCallback((id: string) => {
    stopStreams(id);
    const es = new EventSource(eventsUrl(id));
    es.addEventListener("log", (e) => {
      const data = (e as MessageEvent).data as string;
      setLogs((prev) => ({
        ...prev,
        [id]: [...(prev[id] ?? []), { t: new Date().toLocaleTimeString(), msg: data }],
      }));
    });
    es.addEventListener("done", () => {
      es.close();
      if (streams.current[id]) streams.current[id].es = null;
    });
    es.addEventListener("error", (e) => {
      const data = (e as MessageEvent).data as string;
      if (data) setError(data);
      es.close();
      if (streams.current[id]) streams.current[id].es = null;
    });
    const poll = window.setInterval(async () => {
      try {
        const v = await getVideo(id);
        setTasks((prev) => ({ ...prev, [id]: v }));
        if (TERMINAL.includes(v.status)) stopStreams(id);
      } catch (err) {
        setError(String(err));
      }
    }, 2000);
    streams.current[id] = { es, poll };
  }, [stopStreams]);

  const create = useCallback(async (input: CreateInput) => {
    const prompt = input.prompt.trim();
    if (!prompt) {
      setError("请输入 prompt");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await createVideo(
        prompt,
        input.timeoutSeconds,
        [],
        input.idempotencyKey?.trim() || undefined
      );
      const task: VideoTaskResponse = {
        task_id: res.task_id,
        status: res.status,
        links: res.links,
      };
      setTasks((prev) => ({ ...prev, [res.task_id]: task }));
      setOrder((prev) => [res.task_id, ...prev.filter((x) => x !== res.task_id)]);
      setLogs((prev) => ({ ...prev, [res.task_id]: [] }));
      setActiveId(res.task_id);
      startStreams(res.task_id);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }, [startStreams]);

  const select = useCallback((id: string) => setActiveId(id), []);

  const remove = useCallback(async (id: string) => {
    stopStreams(id);
    setBusy(true);
    try {
      await deleteVideo(id);
      setTasks((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setLogs((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setOrder((prev) => prev.filter((x) => x !== id));
      setActiveId((cur) => (cur === id ? null : cur));
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  }, [stopStreams]);

  const clearError = useCallback(() => setError(null), []);

  const value = useMemo<TasksContextValue>(
    () => ({
      tasks,
      order,
      logs,
      activeId,
      error,
      health,
      busy,
      create,
      select,
      remove,
      fileUrlFor: fileUrl,
      clearError,
    }),
    [tasks, order, logs, activeId, error, health, busy, create, select, remove, clearError]
  );

  return <TasksContext.Provider value={value}>{children}</TasksContext.Provider>;
}
