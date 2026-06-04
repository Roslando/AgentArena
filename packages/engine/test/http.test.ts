import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithRetry } from "../src/providers/http.js";

// Tiny delays so the backoff does not slow the suite.
const FAST = { baseDelayMs: 1, maxDelayMs: 2, timeoutMs: 1000 };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchWithRetry", () => {
  it("retries a transient 5xx, then returns the first OK response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("overloaded", { status: 503 }))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchWithRetry("https://x", { method: "POST" }, "Test", FAST);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a network error, then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchWithRetry("https://x", {}, "Test", FAST);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails fast on a non-retryable 4xx (no retry)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("bad key", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchWithRetry("https://x", {}, "Test", FAST)).rejects.toThrow("401");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after maxAttempts on a persistent rate limit", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("slow down", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchWithRetry("https://x", {}, "Test", { ...FAST, maxAttempts: 3 }),
    ).rejects.toThrow("429");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
