// =============================================================================
// WF9: real-chain API key tests. `../api` is NOT mocked — the real fetch
// wrappers / eventsUrl run against a stubbed global fetch + EventSource, so
// the whole chain (input → localStorage → X-API-Key header / ?api_key= SSE
// param → clear) is exercised end to end in jsdom.
// =============================================================================
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "../App";
import { API_KEY_STORAGE } from "../api";

class FakeEventSource {
  static urls: string[] = [];
  close = vi.fn();
  addEventListener = vi.fn();
  constructor(url: string) {
    FakeEventSource.urls.push(url);
  }
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

function findCreateCall(): [RequestInfo | URL, RequestInit] | undefined {
  return fetchMock.mock.calls.find(
    ([url, init]) =>
      String(url) === "/v1/videos" && (init as RequestInit)?.method === "POST"
  ) as [RequestInfo | URL, RequestInit] | undefined;
}

function submitPrompt(prompt: string) {
  fireEvent.change(screen.getByPlaceholderText(/描述你想生成的视频/), {
    target: { value: prompt },
  });
  fireEvent.click(screen.getByRole("button", { name: /生成视频/ }));
}

beforeEach(() => {
  localStorage.clear();
  FakeEventSource.urls = [];
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/healthz")) return jsonResponse({ status: "ok" });
    if (url.includes("/v1/videos")) {
      return jsonResponse({
        task_id: `task-${fetchMock.mock.calls.length}`,
        status: "queued",
        links: {},
      });
    }
    return jsonResponse({});
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("API key real chain (WF9)", () => {
  it("persists the entered key to localStorage on save", () => {
    render(<App />);
    fireEvent.change(screen.getByPlaceholderText("留空则不使用鉴权"), {
      target: { value: "sk-test-123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(localStorage.getItem(API_KEY_STORAGE)).toBe("sk-test-123");
  });

  it("sends the saved key as X-API-Key on create requests", async () => {
    localStorage.setItem(API_KEY_STORAGE, "sk-live-abc");
    render(<App />);
    submitPrompt("a cat video");
    await waitFor(() => expect(findCreateCall()).toBeTruthy());
    const [, init] = findCreateCall()!;
    expect(init.headers).toMatchObject({ "X-API-Key": "sk-live-abc" });
  });

  it("appends ?api_key= to the SSE subscription URL", async () => {
    localStorage.setItem(API_KEY_STORAGE, "sk-live-abc");
    render(<App />);
    submitPrompt("a dog video");
    await waitFor(() =>
      expect(
        FakeEventSource.urls.some((u) => u.includes("api_key=sk-live-abc"))
      ).toBe(true)
    );
  });

  it("stops sending credentials after the key is cleared", async () => {
    localStorage.setItem(API_KEY_STORAGE, "sk-old");
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "清除" }));
    expect(localStorage.getItem(API_KEY_STORAGE)).toBeNull();

    submitPrompt("a bird video");
    await waitFor(() => expect(findCreateCall()).toBeTruthy());
    const [, init] = findCreateCall()!;
    expect(
      (init.headers as Record<string, string>)["X-API-Key"]
    ).toBeUndefined();
    await waitFor(() => expect(FakeEventSource.urls.length).toBeGreaterThan(0));
    expect(FakeEventSource.urls.every((u) => !u.includes("api_key="))).toBe(true);
  });
});
