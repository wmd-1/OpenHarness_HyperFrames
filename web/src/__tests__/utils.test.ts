import { describe, expect, it } from "vitest";
import {
  safeContentDisposition,
  sanitizeError,
  sanitizeFilename,
  sanitizeText,
  validateAndSanitizeOhArgs,
  validateFilename,
  validatePromptShape,
  validateTimeout,
} from "../utils/sanitize";
import { MAX_OH_ARG_LEN, MAX_OH_ARGS, MAX_PROMPT_CHARS } from "../constants";

const CTRL = String.fromCharCode(7); // bell
const US = String.fromCharCode(0x1f); // unit separator (stripped)

describe("sanitizeText", () => {
  it("strips HTML/script tags", () => {
    expect(sanitizeText("<script>alert(1)</script>")).toBe("alert(1)");
    expect(sanitizeText("<b>hi</b>")).toBe("hi");
  });
  it("strips control characters", () => {
    expect(sanitizeText("a" + CTRL + "b")).toBe("ab");
    expect(sanitizeText("x" + US + "y")).toBe("xy");
  });
  it("strips javascript: pseudo-protocols", () => {
    expect(sanitizeText("javascript:alert(1)")).toBe("alert(1)");
  });
});

describe("validatePromptShape", () => {
  it("rejects empty prompts", () => {
    expect(validatePromptShape("   ")).not.toBeNull();
    expect(validatePromptShape("")).not.toBeNull();
  });
  it("rejects overly long prompts", () => {
    const long = "a".repeat(MAX_PROMPT_CHARS + 1);
    expect(validatePromptShape(long)).toMatch(/过长/);
  });
  it("accepts a normal prompt", () => {
    expect(validatePromptShape("make a cat video")).toBeNull();
  });
});

describe("validateAndSanitizeOhArgs", () => {
  it("drops empty entries and truncates long ones", () => {
    const out = validateAndSanitizeOhArgs(["", "  ", "ok", "x".repeat(MAX_OH_ARG_LEN + 50)]);
    expect(out).toEqual(["ok", "x".repeat(MAX_OH_ARG_LEN)]);
  });
  it("caps the number of args", () => {
    const many = Array.from({ length: MAX_OH_ARGS + 10 }, (_, i) => `a${i}`);
    expect(validateAndSanitizeOhArgs(many)).toHaveLength(MAX_OH_ARGS);
  });
  it("strips markup from args", () => {
    expect(validateAndSanitizeOhArgs(["<b>x</b>"])).toEqual(["x"]);
  });
});

describe("validateFilename / sanitizeFilename", () => {
  it("rejects empty and illegal characters", () => {
    expect(validateFilename("").ok).toBe(false);
    expect(validateFilename("a/b.mp4").ok).toBe(false);
    expect(validateFilename("a:b.mp4").ok).toBe(false);
  });
  it("rejects disallowed extensions", () => {
    expect(validateFilename("evil.exe").ok).toBe(false);
    expect(validateFilename("noext").ok).toBe(false);
  });
  it("accepts allowlisted extensions", () => {
    const v = validateFilename("hyperframes.mp4");
    expect(v.ok).toBe(true);
    expect(v.safeName).toBe("hyperframes.mp4");
  });
  it("always returns a non-empty safe name", () => {
    expect(sanitizeFilename("")).toBe("video.mp4");
    expect(sanitizeFilename("../../../etc/passwd")).not.toContain("..");
  });
});

describe("validateTimeout", () => {
  it("clamps into the allowed range", () => {
    expect(validateTimeout(0)).toBeGreaterThanOrEqual(10);
    expect(validateTimeout(99999)).toBeLessThanOrEqual(3600);
    expect(validateTimeout(NaN)).toBeGreaterThan(0);
  });
  it("rounds finite values", () => {
    expect(validateTimeout(123.6)).toBe(124);
  });
});

describe("sanitizeError", () => {
  it("coerces various inputs into safe strings", () => {
    expect(sanitizeError(null)).toMatch(/错误/);
    expect(sanitizeError(new Error("boom"))).toBe("boom");
    expect(sanitizeError("<script>x</script>")).toBe("x");
    expect(sanitizeError({ message: "nested" })).toBe("nested");
  });
});

describe("safeContentDisposition", () => {
  it("produces a quoted ASCII filename", () => {
    expect(safeContentDisposition("hyperframes.mp4")).toContain('filename="hyperframes.mp4"');
  });
  it("uses RFC5987 encoding for non-ASCII names", () => {
    const cd = safeContentDisposition("视频.mp4");
    expect(cd).toContain("filename*=UTF-8''");
  });
});
