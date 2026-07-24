import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Composer } from "../components/Composer";
import { TasksProvider } from "../store";
import { createVideo } from "../api";

afterEach(() => {
  vi.clearAllMocks();
});

vi.mock("../api", () => ({
  getHealth: vi.fn().mockResolvedValue({ status: "ok" }),
  getVideo: vi.fn(),
  deleteVideo: vi.fn(),
  createVideo: vi.fn(),
  fileUrl: () => "/file",
  eventsUrl: () => "/events",
}));

describe("Composer hardening", () => {
  it("blocks empty prompts and shows a safe error", async () => {
    render(
      <TasksProvider>
        <Composer />
      </TasksProvider>
    );
    fireEvent.click(screen.getByRole("button", { name: /生成视频/ }));
    expect(await screen.findByText(/提示词.*不能为空/)).toBeTruthy();
    expect(createVideo).not.toHaveBeenCalled();
  });

  it("sanitizes the prompt before calling createVideo", async () => {
    vi.mocked(createVideo).mockResolvedValue({
      task_id: "c1",
      status: "queued",
      links: {},
    } as never);
    render(
      <TasksProvider>
        <Composer />
      </TasksProvider>
    );
    fireEvent.change(screen.getByLabelText(/提示词/), {
      target: { value: "  cat video  " },
    });
    fireEvent.change(screen.getByLabelText(/超时/), { target: { value: "120" } });
    fireEvent.click(screen.getByRole("button", { name: /生成视频/ }));

    await waitFor(() => expect(createVideo).toHaveBeenCalled());
    const [prompt, timeout] = vi.mocked(createVideo).mock.calls[0];
    expect(prompt).toBe("cat video");
    expect(timeout).toBe(120);
  });

  it("rejects an illegal download filename", async () => {
    render(
      <TasksProvider>
        <Composer />
      </TasksProvider>
    );
    fireEvent.change(screen.getByLabelText(/提示词/), {
      target: { value: "make a video" },
    });
    fireEvent.change(screen.getByLabelText(/下载文件名/), {
      target: { value: "a/b.mp4" },
    });
    fireEvent.click(screen.getByRole("button", { name: /生成视频/ }));

    expect(await screen.findByText(/非法字符/)).toBeTruthy();
    expect(createVideo).not.toHaveBeenCalled();
  });
});
