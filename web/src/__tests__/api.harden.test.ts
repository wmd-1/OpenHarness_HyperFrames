import { afterEach, describe, expect, it, vi } from "vitest";
import { createVideo, eventsUrl, fileUrl, getHealth } from "../api";

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "application/json" },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("fileUrl / eventsUrl hardening", () => {
  it("never emits path-traversal segments", () => {
    const u = fileUrl("../../etc/passwd");
    expect(u).not.toContain("..");
    expect(u).toContain("/v1/videos/");
  });
  it("encodes the id for the URL path", () => {
    expect(fileUrl("a:b")).toContain("/v1/videos/a%3Ab/file");
    expect(eventsUrl("t9")).toContain("/v1/videos/t9/events");
  });
});

describe("getHealth hardening", () => {
  it("treats a thrown fetch as degraded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("network down"))
    );
    expect((await getHealth()).status).toBe("degraded");
  });

  it("treats non-object / non-ok responses as degraded", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(null, 500))
    );
    expect((await getHealth()).status).toBe("degraded");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse("not-an-object", 200))
    );
    expect((await getHealth()).status).toBe("degraded");
  });

  it("returns the health object when ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ status: "ok", uptime: 42 }))
    );
    const h = await getHealth();
    expect(h.status).toBe("ok");
    expect((h as { uptime?: number }).uptime).toBe(42);
  });
});

describe("createVideo hardening", () => {
  it("throws when the response is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => "text/html" },
        json: async () => ({}),
        text: async () => "<!doctype html>",
      } as unknown as Response)
    );
    await expect(
      createVideo("hi", 60, [], "k")
    ).rejects.toThrow(/Expected JSON/);
  });

  it("throws on non-2xx responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ error: "boom" }, 500))
    );
    await expect(createVideo("hi", 60, [], "k")).rejects.toThrow(/HTTP 500/);
  });

  it("round-trips a valid task", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({ task_id: "abc", status: "queued", links: {} })
      )
    );
    const t = await createVideo("hi", 60, ["--x"], "k");
    expect(t.task_id).toBe("abc");
    expect(t.status).toBe("queued");
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
