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
  type TaskStatus,
} from "./api";
import {
  API_RATE_LIMIT_MS,
  EVENT_MAX_RETRIES,
  EVENT_RETRY_MS,
  MAX_POLL_FAILURES,
  PROGRESS_POLL_MS,
} from "./constants";
import {
  sanitizeError,
  sanitizeLogLine,
  sanitizeText,
  validateAndSanitizeOhArgs,
  validateFilename,
  validatePromptShape,
  validateTimeout,
} from "./utils/sanitize";

// Backend status enum is a fixed, lowercase set; anything else is coerced.
const VALID_STATUSES: ReadonlySet<string> = new Set([
  "queued",
  "running",
  "succeeded",
  "failed",
  "canceled",
]);
const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "succeeded",
  "failed",
  "canceled",
]);

export interface TaskLog {
  ts: string;
  line: string;
}

export interface Task {
  id: string;
  status: TaskStatus;
  prompt?: string;
  createdAt?: string;
  error?: string;
  progress?: number;
  links: { self: string; file: string; events: string };
  logs: TaskLog[];
}

interface TasksContextValue {
  tasks: Task[];
  selectedId: string | null;
  selectedTask?: Task;
  error: string | null;
  selectTask: (id: string | null) => void;
  createTask: (
    prompt: string,
    ohArgs?: string[],
    filename?: string,
    timeoutSeconds?: number
  ) => Promise<Task | null>;
  cancelTask: (id: string) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;
  downloadVideo: (id: string, filename?: string) => Promise<void>;
  refreshHealth: () => Promise<void>;
  health: "ok" | "degraded";
  clearError: () => void;
}

const Ctx = createContext<TasksContextValue | null>(null);

/** Generate a client-side idempotency key for create requests. */
function generateIdempotencyKey(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
  } catch {
    /* fall through */
  }
  return `idem-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function clampProgress(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

export function TasksProvider({ children }: { children: ReactNode }) {
  const [tasksState, setTasksState] = useState<Task[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [health, setHealth] = useState<"ok" | "degraded">("ok");
  const [error, setError] = useState<string | null>(null);

  // --- rAF-batched task updates (avoids interleaved setState races) --------
  const tasksRef = useRef<Task[]>(tasksState);
  const pendingRef = useRef<Task[] | null>(null);
  const rafRef = useRef<number | null>(null);

  const flush = useCallback(() => {
    rafRef.current = null;
    if (pendingRef.current) {
      tasksRef.current = pendingRef.current;
      setTasksState(pendingRef.current);
      pendingRef.current = null;
    }
  }, []);

  const setTasks = useCallback(
    (updater: Task[] | ((prev: Task[]) => Task[])) => {
      const next =
        typeof updater === "function"
          ? (updater as (prev: Task[]) => Task[])(tasksRef.current)
          : updater;
      tasksRef.current = next;
      pendingRef.current = next;
      if (rafRef.current == null) {
        rafRef.current = requestAnimationFrame(flush);
      }
    },
    [flush]
  );

  // Active SSE streams, poll timers and retry counters, keyed by task id.
  const eventSources = useRef<Map<string, EventSource>>(new Map());
  const pollTimers = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());
  const retryCount = useRef<Map<string, number>>(new Map());
  const pollFailures = useRef<Map<string, number>>(new Map());
  const lastCreateAt = useRef<number>(0);

  const stopTracking = useCallback((id: string) => {
    const es = eventSources.current.get(id);
    if (es) {
      es.close();
      eventSources.current.delete(id);
    }
    const timer = pollTimers.current.get(id);
    if (timer != null) {
      clearInterval(timer);
      pollTimers.current.delete(id);
    }
    retryCount.current.delete(id);
  }, []);

  const refreshTask = useCallback(
    async (id: string) => {
      const exists = tasksRef.current.some((t) => t.id === id);
      if (!exists) return;
      try {
        const data = await getVideo(id);
        const rawStatus = typeof data?.status === "string" ? data.status : "";
        const status: TaskStatus = VALID_STATUSES.has(rawStatus)
          ? (rawStatus as TaskStatus)
          : "failed";
        setTasks((prev) =>
          prev.map((t) =>
            t.id === id
              ? {
                  ...t,
                  status,
                  progress: clampProgress((data as { progress?: unknown }).progress),
                  error:
                    status === "failed"
                      ? sanitizeError(data?.error ?? t.error)
                      : t.error,
                }
              : t
          )
        );
        pollFailures.current.delete(id);
        if (TERMINAL_STATUSES.has(status)) {
          stopTracking(id);
        }
      } catch (err) {
        // A transient poll failure must not crash the UI. After enough
        // consecutive failures we stop tracking the task entirely (B1).
        if (!TERMINAL_STATUSES.has(tasksRef.current.find((t) => t.id === id)?.status ?? "queued")) {
          const fails = (pollFailures.current.get(id) ?? 0) + 1;
          pollFailures.current.set(id, fails);
          if (fails >= MAX_POLL_FAILURES) {
            stopTracking(id);
          } else {
            setTasks((prev) =>
              prev.map((t) =>
                t.id === id ? { ...t, error: sanitizeError(err) } : t
              )
            );
          }
        }
      }
    },
    [setTasks, stopTracking]
  );

  const openEventStream = useCallback(
    (id: string) => {
      // Tear down any prior stream for this task first.
      const prior = eventSources.current.get(id);
      if (prior) prior.close();
      retryCount.current.set(id, 0);

      const start = () => {
        let es: EventSource;
        try {
          es = new EventSource(eventsUrl(id));
        } catch {
          return;
        }
        eventSources.current.set(id, es);

        const handleTerminal = (status: TaskStatus, message?: string) => {
          setTasks((prev) =>
            prev.map((t) =>
              t.id === id
                ? {
                    ...t,
                    status,
                    error: status === "failed" ? sanitizeError(message ?? t.error) : t.error,
                  }
                : t
            )
          );
          stopTracking(id);
        };

        es.addEventListener("log", (ev) => {
          const line = sanitizeLogLine((ev as MessageEvent).data);
          setTasks((prev) =>
            prev.map((t) =>
              t.id === id
                ? { ...t, logs: [...t.logs, { ts: new Date().toLocaleTimeString(), line }] }
                : t
            )
          );
        });
        es.addEventListener("done", (ev) => {
          let message: string | undefined;
          try {
            message = JSON.parse((ev as MessageEvent).data)?.message;
          } catch {
            message = undefined;
          }
          handleTerminal("succeeded", message);
        });
        es.addEventListener("error", (ev) => {
          // Native EventSource "error" events fire on every dropped
          // connection; do not treat them as task failure.
          const data = (ev as MessageEvent)?.data;
          if (data && typeof data === "string") {
            const parsed = (() => {
              try {
                return JSON.parse(data);
              } catch {
                return null;
              }
            })();
            if (parsed?.status === "failed") {
              handleTerminal("failed", parsed?.message);
              return;
            }
          }
          // Otherwise attempt a bounded reconnect with backoff.
          const attempt = (retryCount.current.get(id) ?? 0) + 1;
          retryCount.current.set(id, attempt);
          es.close();
          eventSources.current.delete(id);
          if (attempt > EVENT_MAX_RETRIES) {
            stopTracking(id);
            return;
          }
          const delay = EVENT_RETRY_MS * attempt;
          setTimeout(() => {
            if (tasksRef.current.some((t) => t.id === id)) start();
          }, delay);
        });
      };

      start();
    },
    [setTasks, stopTracking]
  );

  const pollTask = useCallback(
    (id: string) => {
      if (pollTimers.current.has(id)) return;
      const timer = setInterval(() => {
        void refreshTask(id);
      }, PROGRESS_POLL_MS);
      pollTimers.current.set(id, timer);
    },
    [refreshTask]
  );

  const createTask = useCallback(
    async (
      prompt: string,
      ohArgs: string[] = [],
      filename?: string,
      timeoutSeconds?: number
    ): Promise<Task | null> => {
      const shapeError = validatePromptShape(prompt);
      if (shapeError) {
        setError(shapeError);
        return null;
      }
      const now = Date.now();
      if (now - lastCreateAt.current < API_RATE_LIMIT_MS) {
        setError("操作过于频繁，请稍候再试");
        return null;
      }
      lastCreateAt.current = now;

      const safePrompt = sanitizeText(prompt).slice(0, 4000).trim();
      const safeArgs = validateAndSanitizeOhArgs(ohArgs);
      const safeTimeout = validateTimeout(timeoutSeconds);
      const idemKey = generateIdempotencyKey();

      // Optionally validate the requested download filename up front so the
      // user gets immediate feedback (the download itself re-validates).
      if (filename && filename.trim()) {
        const v = validateFilename(filename);
        if (!v.ok) {
          setError(v.error ?? "文件名不合法");
          return null;
        }
      }

      try {
        const task = await createVideo(safePrompt, safeTimeout, safeArgs, idemKey);
        const newTask: Task = {
          id: task.task_id,
          status: VALID_STATUSES.has(task.status) ? (task.status as TaskStatus) : "queued",
          prompt: safePrompt,
          createdAt: new Date().toLocaleString(),
          links: {
            self: task.links?.self ?? "",
            file: task.links?.file ?? fileUrl(task.task_id),
            events: task.links?.events ?? eventsUrl(task.task_id),
          },
          logs: [],
        };
        setTasks((prev) => [newTask, ...prev]);
        setSelectedId(newTask.id);
        setError(null);
        openEventStream(newTask.id);
        pollTask(newTask.id);
        return newTask;
      } catch (err) {
        setError(sanitizeError(err));
        return null;
      }
    },
    [openEventStream, pollTask, setTasks]
  );

  const cancelTask = useCallback(
    async (id: string) => {
      stopTracking(id);
      setTasks((prev) =>
        prev.map((t) => (t.id === id ? { ...t, status: "canceled" } : t))
      );
      try {
        await deleteVideo(id);
      } catch {
        /* best-effort */
      }
    },
    [setTasks, stopTracking]
  );

  const deleteTask = useCallback(
    async (id: string) => {
      stopTracking(id);
      setTasks((prev) => prev.filter((t) => t.id !== id));
      setSelectedId((cur) => (cur === id ? null : cur));
      try {
        await deleteVideo(id);
      } catch {
        /* best-effort */
      }
    },
    [setTasks, stopTracking]
  );

  const downloadVideo = useCallback(
    async (id: string, filename?: string) => {
      const v = validateFilename(filename && filename.trim() ? filename : `${id}.mp4`);
      if (!v.ok) {
        setError(v.error ?? "文件名不合法");
        return;
      }
      const safeName = v.safeName;
      const url = fileUrl(id);
      try {
        const res = await fetch(url);
        if (!res.ok) {
          setError(`下载失败：HTTP ${res.status}`);
          return;
        }
        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = objectUrl;
        a.download = safeName;
        a.setAttribute("rel", "noopener");
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(objectUrl);
      } catch (err) {
        setError(sanitizeError(err));
      }
    },
    [setError]
  );

  const refreshHealth = useCallback(async () => {
    try {
      const h = await getHealth();
      setHealth(h.status === "ok" ? "ok" : "degraded");
    } catch {
      setHealth("degraded");
    }
  }, []);

  const selectTask = useCallback((id: string | null) => setSelectedId(id), []);
  const clearError = useCallback(() => setError(null), []);

  // Initial health probe + cleanup of all streams/polls on unmount.
  useEffect(() => {
    void refreshHealth();
    const interval = setInterval(() => void refreshHealth(), 15000);
    return () => {
      if (interval) clearInterval(interval);
      eventSources.current.forEach((es) => es.close());
      pollTimers.current.forEach((t) => clearInterval(t));
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [refreshHealth]);

  const selectedTask = useMemo(
    () => tasksState.find((t) => t.id === selectedId),
    [tasksState, selectedId]
  );

  const value = useMemo<TasksContextValue>(
    () => ({
      tasks: tasksState,
      selectedId,
      selectedTask,
      error,
      selectTask,
      createTask,
      cancelTask,
      deleteTask,
      downloadVideo,
      refreshHealth,
      health,
      clearError,
    }),
    [
      tasksState,
      selectedId,
      selectedTask,
      error,
      selectTask,
      createTask,
      cancelTask,
      deleteTask,
      downloadVideo,
      refreshHealth,
      health,
      clearError,
    ]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTasks(): TasksContextValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useTasks must be used within TasksProvider");
  return ctx;
}
