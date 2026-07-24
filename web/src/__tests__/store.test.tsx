import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
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
function Capture() {
  captured = useTasks();
  return null;
}

let utils: ReturnType<typeof render> | null = null;

beforeEach(() => {
  hoisted.createVideo.mockResolvedValue({ task_id: "t1", status: "queued", links: {} });
  // Make rAF batching flush synchronously for deterministic assertions.
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
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
    expect(captured!.tasks.some((t) => t.id === "t1")).toBe(true);
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
