import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "../App";

// Mock the api module so the store (imports ./api) uses fakes.
vi.mock("../api", () => ({
  getHealth: vi.fn().mockResolvedValue({ status: "ok" }),
  getVideo: vi.fn().mockResolvedValue({
    task_id: "task-uuid-1234",
    status: "queued",
    links: { self: "", file: "", events: "" },
  }),
  createVideo: vi.fn().mockResolvedValue({
    task_id: "task-uuid-1234",
    status: "queued",
    links: { self: "", file: "", events: "" },
  }),
  deleteVideo: vi.fn().mockResolvedValue({
    task_id: "x",
    status: "canceled",
    message: "ok",
  }),
  fileUrl: (id: string) => "/v1/videos/" + id + "/file",
  eventsUrl: (id: string) => "/v1/videos/" + id + "/events",
}));

import * as api from "../api";

class FakeEventSource {
  static lastUrl: string | null = null;
  close = vi.fn();
  addEventListener = vi.fn();
  constructor(url: string) {
    FakeEventSource.lastUrl = url;
  }
}

beforeEach(() => {
  FakeEventSource.lastUrl = null;
  vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
});
afterEach(() => vi.unstubAllGlobals());

describe("App", () => {
  it("blocks empty-prompt submit and shows a hint", async () => {
    render(<App />);
    const btn = screen.getByRole("button", { name: /生成视频/ });
    fireEvent.click(btn);
    expect(await screen.findByText(/提示词.*不能为空/)).toBeTruthy();
    expect(api.createVideo).not.toHaveBeenCalled();
  });

  it("submits a task, shows its id and opens an SSE stream", async () => {
    render(<App />);
    const textarea = screen.getByPlaceholderText(/描述你想生成的视频/);
    fireEvent.change(textarea, { target: { value: "make a cat video" } });
    const btn = screen.getByRole("button", { name: /生成视频/ });
    fireEvent.click(btn);

    const ids = await screen.findAllByText(/task-uui/);
    expect(ids.length).toBeGreaterThan(0);
    await waitFor(() =>
      expect(FakeEventSource.lastUrl).toContain("task-uuid-1234")
    );
    expect(api.createVideo).toHaveBeenCalledWith(
      "make a cat video",
      expect.any(Number),
      [],
      expect.any(String)
    );
  });
});
