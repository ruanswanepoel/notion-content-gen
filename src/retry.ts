import { APIResponseError } from "@notionhq/client";

export type RetryOptions = {
  /** Maximum attempts including the first call. Defaults to 5. */
  maxAttempts?: number;
  /** Base delay in ms for exponential backoff. Defaults to 500ms. */
  baseDelayMs?: number;
  /** Upper bound for any single sleep, in ms. Defaults to 30s. */
  maxDelayMs?: number;
};

const DEFAULTS: Required<RetryOptions> = {
  maxAttempts: 5,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
};

/**
 * Wraps a Notion API call with retry-on-429 / retry-on-5xx and exponential
 * backoff. Respects `Retry-After` when Notion sends it. Re-throws unrelated
 * errors immediately.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const { maxAttempts, baseDelayMs, maxDelayMs } = { ...DEFAULTS, ...options };
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      if (attempt >= maxAttempts || !isRetryable(err)) throw err;
      const wait = computeDelay(err, attempt, baseDelayMs, maxDelayMs);
      await sleep(wait);
    }
  }
}

function isRetryable(err: unknown): boolean {
  if (err instanceof APIResponseError) {
    const status = err.status;
    if (status === 429) return true;
    if (status >= 500 && status < 600) return true;
    return false;
  }
  // Network-level errors (ECONNRESET, ETIMEDOUT, fetch aborts) are worth a retry.
  const code = (err as { code?: string } | null)?.code;
  if (
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    code === "UND_ERR_SOCKET"
  ) {
    return true;
  }
  return false;
}

function computeDelay(
  err: unknown,
  attempt: number,
  base: number,
  max: number,
): number {
  const retryAfterMs = parseRetryAfter(err);
  if (retryAfterMs !== null) return Math.min(retryAfterMs, max);
  // Exponential backoff with full jitter.
  const exp = Math.min(max, base * 2 ** (attempt - 1));
  return Math.floor(Math.random() * exp);
}

function parseRetryAfter(err: unknown): number | null {
  if (!(err instanceof APIResponseError)) return null;
  const headers = (err as unknown as { headers?: Headers | Record<string, string> })
    .headers;
  if (!headers) return null;
  const value =
    typeof (headers as Headers).get === "function"
      ? (headers as Headers).get("retry-after")
      : (headers as Record<string, string>)["retry-after"];
  if (!value) return null;
  const asNumber = Number(value);
  if (Number.isFinite(asNumber)) return asNumber * 1000;
  const asDate = Date.parse(value);
  if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now());
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
