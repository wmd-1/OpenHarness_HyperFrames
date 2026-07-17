import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createVideo,
  deleteVideo,
  eventsUrl,
  fileUrl,
  getHealth,
  getVideo,
} from "../api";

describe("api client", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("createVideo POSTs to /v1/videos with JSON body and returns parsed task", async () => {
    const fake = {
      task_id: "abc-123",
      status: "queued" as const,
      links: {
        self: "/v1/videos/abc-123",
        file: "/v1/videos/abc-123/file",
        events: "/v1/videos/abc-123/events",
      },
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => fake,
      text: async () => "",
    });
    vi.stubGlobal("fetch", fetchMock);

    const res = await createVideo("hello", 600, [], "key-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/v1/videos");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(init.body)).toEqual({
      prompt: "hello",
      timeout_seconds: 600,
      extra_oh_args: [],
      idempotency_key: "key-1",
    });
    expect(res.task_id).toBe("abc-123");
  });

  it("createVideo omits idempotency_key when not provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ task_id: "x", status: "queued", links: {} }),
      text: async () => "",
    });
    vi.stubGlobal("fetch", fetchMock);
    await createVideo("hi", 60);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).not.toHaveProperty("idempotency_key");
  });

  it("throws on non-ok response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Server Error",
        text: async () => "boom",
      })
    );
    await expect(createVideo("x", 1)).rejects.toThrow("HTTP 500: boom");
  });

  it("getVideo requests /v1/videos/:id", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ task_id: "t1", status: "running", links: {} }),
      text: async () => "",
    });
    vi.stubGlobal("fetch", fetchMock);
    await getVideo("t1");
    expect(fetchMock.mock.calls[0][0]).toBe("/v1/videos/t1");
  });

  it("deleteVideo sends DELETE", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ task_id: "t1", status: "canceled", message: "ok" }),
      text: async () => "",
    });
    vi.stubGlobal("fetch", fetchMock);
    await deleteVideo("t1");
    expect(fetchMock.mock.calls[0][1].method).toBe("DELETE");
  });

  it("getHealth hits /healthz", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: "ok" }),
      text: async () => "",
    });
    vi.stubGlobal("fetch", fetchMock);
    const h = await getHealth();
    expect(h.status).toBe("ok");
    expect(fetchMock.mock.calls[0][0]).toBe("/healthz");
  });

  it("fileUrl/eventsUrl build correct same-origin paths", () => {
    expect(fileUrl("t9")).toBe("/v1/videos/t9/file");
    expect(eventsUrl("t9")).toBe("/v1/videos/t9/events");
  });
});
