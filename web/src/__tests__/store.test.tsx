import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { TasksProvider, useTasks } from "../store";

const hoisted = vi.hoisted(() => ({ createVideo: vi.fn() }));

vi.mock("../api", () => ({
  getHealth: vi.fn().mockResolvedValue({ status: "ok" }),
  getVideo: vi.fn().mockResolvedValue({ task_id: "t1", status: "running", links: {} }),
  deleteVideo: vi.fn().mockResolvedValue({ task_id: "t1", status: "canceled", links: {} }),
  createVideo: (...args: unknown[]) => hoisted.createVideo(...args),
  fileUrl: (id: string) => `/v1/videos/${id}/file`,
  eventsUrl: (id: string) => `/v1/videos/${id}/events`,
}));

let captured: ReturnType<typeof useTasks> | null = null;
// Distinct `tasks` references seen across renders == number of state commits.
const tasksCommits: unknown[] = [];
function Capture() {
  captured = useTasks();
  if (tasksCommits[tasksCommits.length - 1] !== captured.tasks) {
    tasksCommits.push(captured.tasks);
  }
  return null;
}

let utils: ReturnType<typeof render> | null = null;

beforeEach(() => {
  hoisted.createVideo.mockResolvedValue({ task_id: "t1", status: "queued", links: {} });
  tasksCommits.length = 0;
});

afterEach(() => {
  utils?.unmount();
  utils = null;
  captured = null;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("createTask hardening", () => {
  it("rejects an empty prompt without calling the API", async () => {
    utils = render(
      <TasksProvider>
        <Capture />
      </TasksProvider>
    );
    await act(async () => {
      await captured!.createTask("   ");
    });
    expect(hoisted.createVideo).not.toHaveBeenCalled();
    expect(captured!.error).not.toBeNull();
  });

  it("sanitizes the prompt and sends an idempotency key", async () => {
    utils = render(
      <TasksProvider>
        <Capture />
      </TasksProvider>
    );
    await act(async () => {
      await captured!.createTask("  hello world  ");
    });
    expect(hoisted.createVideo).toHaveBeenCalledTimes(1);
    const [prompt, , , key] = hoisted.createVideo.mock.calls[0];
    expect(prompt).toBe("hello world");
    expect(key).toEqual(expect.any(String));
    expect(captured!.error).toBeNull();
    // The batched flush commits ~32ms later (WF10); wait for it.
    await waitFor(() =>
      expect(captured!.tasks.some((t) => t.id === "t1")).toBe(true)
    );
  });

  it("rejects a disallowed download filename before creating", async () => {
    utils = render(
      <TasksProvider>
        <Capture />
      </TasksProvider>
    );
    await act(async () => {
      await captured!.createTask("make a video", [], "evil.exe", 600);
    });
    expect(hoisted.createVideo).not.toHaveBeenCalled();
    expect(captured!.error).toMatch(/扩展名/);
  });
});

describe("downloadVideo hardening", () => {
  it("does not fetch for an illegal filename", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob() });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:x"),
      revokeObjectURL: vi.fn(),
    } as unknown as typeof URL);

    utils = render(
      <TasksProvider>
        <Capture />
      </TasksProvider>
    );
    await act(async () => {
      await captured!.downloadVideo("t1", "a/b.mp4");
    });
    expect(captured!.error).not.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches with a safe filename when valid", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob() });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:x"),
      revokeObjectURL: vi.fn(),
    } as unknown as typeof URL);

    utils = render(
      <TasksProvider>
        <Capture />
      </TasksProvider>
    );
    await act(async () => {
      await captured!.downloadVideo("t1", "good.mp4");
    });
    expect(fetchMock).toHaveBeenCalledWith("/v1/videos/t1/file");
  });
});

describe("batched flush scheduling (WF10)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("commits pending updates via a 32ms setTimeout (fires in hidden tabs too)", async () => {
    utils = render(
      <TasksProvider>
        <Capture />
      </TasksProvider>
    );
    await act(async () => {
      await captured!.createTask("timer flush regression");
    });
    // Inside the merge window: nothing committed yet.
    expect(captured!.tasks).toHaveLength(0);
    act(() => {
      vi.advanceTimersByTime(32);
    });
    expect(captured!.tasks.some((t) => t.id === "t1")).toBe(true);
  });

  it("coalesces multiple updates in one window into a single commit", async () => {
    utils = render(
      <TasksProvider>
        <Capture />
      </TasksProvider>
    );
    await act(async () => {
      await captured!.createTask("coalesce test");
    });
    act(() => {
      vi.advanceTimersByTime(32);
    });
    const commitsBefore = tasksCommits.length;
    const refBefore = captured!.tasks;
    // Two updates inside the same merge window (both call setTasks).
    await act(async () => {
      void captured!.cancelTask("t1");
      void captured!.deleteTask("t1");
    });
    // Still uncommitted: same reference as before the window.
    expect(captured!.tasks).toBe(refBefore);
    act(() => {
      vi.advanceTimersByTime(32);
    });
    // Exactly one commit, holding the merged final state (t1 removed).
    expect(tasksCommits.length).toBe(commitsBefore + 1);
    expect(captured!.tasks).toHaveLength(0);
  });

  it("does not setState after unmount when the window expires later", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    utils = render(
      <TasksProvider>
        <Capture />
      </TasksProvider>
    );
    await act(async () => {
      await captured!.createTask("unmount cleanup test");
    });
    utils.unmount();
    utils = null;
    act(() => {
      vi.advanceTimersByTime(64);
    });
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
