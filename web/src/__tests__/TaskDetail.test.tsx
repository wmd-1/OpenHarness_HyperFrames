import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TaskDetail } from "../components/TaskDetail";
import { TasksProvider, type Task } from "../store";

vi.mock("../api", () => ({
  getHealth: vi.fn().mockResolvedValue({ status: "ok" }),
  getVideo: vi.fn(),
  deleteVideo: vi.fn(),
  createVideo: vi.fn(),
  fileUrl: () => "/file",
  eventsUrl: () => "/events",
}));

function makeTask(status: Task["status"]): Task {
  return {
    id: "t1",
    status,
    links: { self: "", file: "/file", events: "" },
    logs: [],
  };
}

describe("TaskDetail hardening", () => {
  it("renders the task id as escaped text", () => {
    render(
      <TasksProvider>
        <TaskDetail task={makeTask("running")} />
      </TasksProvider>
    );
    expect(screen.getByText("t1")).toBeTruthy();
  });

  it("disables download until the task succeeds", () => {
    render(
      <TasksProvider>
        <TaskDetail task={makeTask("running")} />
      </TasksProvider>
    );
    expect(screen.getByRole("button", { name: /下载视频/ })).toBeDisabled();
  });

  it("downloads with a safe filename when succeeded", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => new Blob(),
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:x"),
      revokeObjectURL: vi.fn(),
    } as unknown as typeof URL);

    render(
      <TasksProvider>
        <TaskDetail task={makeTask("succeeded")} />
      </TasksProvider>
    );
    fireEvent.click(screen.getByRole("button", { name: /下载视频/ }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/file"));
  });

  it("rejects a disallowed download extension", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(
      <TasksProvider>
        <TaskDetail task={makeTask("succeeded")} />
      </TasksProvider>
    );
    fireEvent.change(screen.getByLabelText(/下载文件名/), {
      target: { value: "x.exe" },
    });
    fireEvent.click(screen.getByRole("button", { name: /下载视频/ }));

    expect(await screen.findByText(/扩展名/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
