export type FailureCategory = "capacity" | "rate limit" | "auth" | "quota" | "server" | "cancelled" | "unknown";

/** Only these fields may survive a failed request; provider text is never retained. */
export interface FailureCause {
  status?: number;
  category: FailureCategory;
  retryAfterSeconds?: number;
}

function httpStatus(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 599 ? value : undefined;
}

function retrySeconds(value: unknown): number | undefined {
  if (typeof value === "string" && /^\d{1,5}$/.test(value)) value = Number(value);
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 86_400 ? value : undefined;
}

/** Structured HTTP metadata wins over the SDK's untrusted error-message fallback. */
export function normalizeFailure(error: unknown, transport?: FailureCause, cancelled = false): FailureCause {
  if (cancelled) return { category: "cancelled" };
  const record = error !== null && typeof error === "object" ? error as Record<string, unknown> : undefined;
  if (record?.name === "AbortError") return { category: "cancelled" };
  const value = typeof error === "string" ? error : record?.message;
  // Bound parsing work, not the output: no substring is ever included in a diagnostic.
  const text = typeof value === "string" ? value.slice(0, 8192) : "";
  const status = transport?.status ?? httpStatus(record?.status) ?? httpStatus(record?.statusCode)
    ?? httpStatus(Number(/^\s*(?:HTTP\s+)?([45]\d{2})(?=[:\s]|$)/i.exec(text)?.[1]));
  const headers = record?.headers;
  const retryAfter = headers instanceof Headers ? headers.get("retry-after")
    : headers !== null && typeof headers === "object" ? (headers as Record<string, unknown>)["retry-after"] : undefined;
  const retryAfterSeconds = transport?.retryAfterSeconds ?? retrySeconds(retryAfter) ?? retrySeconds(record?.retryAfter)
    ?? retrySeconds(/\b(?:retry\s+)?after\s+(\d{1,5})\s*(?:s\b|seconds?\b)/i.exec(text)?.[1]);
  let category: FailureCategory = "unknown";
  if (/\bttft_admission_refused\b|\bat capacity\b|\bcapacity\b/i.test(text)) category = "capacity";
  else if (/\bquota\b|\binsufficient_quota\b/i.test(text)) category = "quota";
  else if (/\brate[ _-]limit(?:ed|ing|_exceeded)?\b|\btoo many requests\b/i.test(text)) category = "rate limit";
  else if (status === 401 || status === 403) category = "auth";
  else if (status === 429) category = "rate limit";
  else if (status !== undefined && status >= 500) category = "server";
  return { status, category, retryAfterSeconds };
}
