/**
 * Shared HTTP helper for the LLM providers: a single `fetch` wrapped with
 * retry-on-transient-failure, so one network blip or rate-limit no longer
 * throws away a whole match.
 *
 * Strategy follows the current industry standard (AWS "Timeouts, retries and
 * backoff with jitter"; the cloud-SDK retry modes; OpenAI/Anthropic cookbooks):
 *   - capped exponential backoff with jitter (avoids synchronized retry storms),
 *   - honor the server's `Retry-After` header on 429/503,
 *   - a per-attempt timeout (retries paired with timeouts, never hang forever),
 *   - a hard attempt cap.
 * Only transient failures are retried — network errors, HTTP 429 and 5xx. Other
 * 4xx client errors (e.g. 401 bad key, 400 bad request) fail fast, because
 * retrying them cannot help.
 *
 * This wraps the LLM network call ONLY. The match turn loop is untouched and
 * still acts as the final safety net once these retries are exhausted.
 */

export interface RetryOptions {
  /** Total attempts including the first one. */
  maxAttempts?: number;
  /** Backoff before jitter for the first retry; doubles each attempt. */
  baseDelayMs?: number;
  /** Cap on any single wait. */
  maxDelayMs?: number;
  /** Per-attempt timeout — aborts a request that hangs. */
  timeoutMs?: number;
}

const DEFAULTS: Required<RetryOptions> = {
  maxAttempts: 5,
  baseDelayMs: 500,
  maxDelayMs: 8000,
  timeoutMs: 120000,
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Transient failures worth retrying: rate limits (429) and server errors (5xx). */
function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

/** Parse a `Retry-After` header (delta-seconds or HTTP-date) into milliseconds. */
function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

/** Capped exponential backoff with equal jitter — stays in [exp/2, exp], never 0. */
function backoffMs(attempt: number, base: number, cap: number): number {
  const exp = Math.min(cap, base * 2 ** (attempt - 1));
  return exp / 2 + Math.random() * (exp / 2);
}

/**
 * POST/GET with retry. Returns the first OK response; throws the last error once
 * retries are exhausted or on a non-retryable status. `label` names the provider
 * in the thrown error message (e.g. "OpenAI").
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  label: string,
  options: RetryOptions = {},
): Promise<Response> {
  const { maxAttempts, baseDelayMs, maxDelayMs, timeoutMs } = { ...DEFAULTS, ...options };
  let lastError: Error = new Error(`${label}: request never attempted`);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response | null = null;
    try {
      res = await fetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    } finally {
      clearTimeout(timer);
    }

    if (res) {
      if (res.ok) return res;
      const body = await res.text().catch(() => "unknown");
      lastError = new Error(`${label} API error ${res.status}: ${body}`);
      if (!isRetryableStatus(res.status)) throw lastError; // client error — fail fast
    }

    if (attempt >= maxAttempts) break;
    const retryAfter = res ? parseRetryAfter(res.headers.get("retry-after")) : null;
    await sleep(Math.min(maxDelayMs, retryAfter ?? backoffMs(attempt, baseDelayMs, maxDelayMs)));
  }

  throw lastError;
}
