export const usageUrl = "https://opencode.ai/zen/go/v1/usage";
const maxBody = 65536;

export interface QuotaWindow {
  exhausted: boolean;
  /** Share of the window still available, 0-100. */
  remaining: number;
  resetsAt: number | null;
}

export interface QuotaObservation {
  windows: QuotaWindow[];
  receivedAt: number;
}

export type QuotaResult =
  | { kind: "ok"; observation: QuotaObservation }
  | { kind: "unauthorized" }
  | { kind: "failed" };

function window(value: unknown): QuotaWindow | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { status, percent, resetsAt } = value as Record<string, unknown>;
  if ((status !== "ok" && status !== "rate-limited") || typeof percent !== "number"
    || !Number.isFinite(percent) || percent < 0 || percent > 100) return undefined;
  let reset: number | null = null;
  if (resetsAt !== undefined && resetsAt !== null) {
    reset = typeof resetsAt === "string" ? Date.parse(resetsAt) : Number.NaN;
    if (!Number.isFinite(reset)) return undefined;
  }
  return { exhausted: status === "rate-limited" || percent >= 100, remaining: 100 - percent, resetsAt: reset };
}

/** Strict parser for the shape two independent clients use; anything else is unknown. */
export function parseUsage(text: string, receivedAt: number): QuotaObservation | undefined {
  if (text.length === 0 || Buffer.byteLength(text) > maxBody) return undefined;
  let payload: unknown;
  try { payload = JSON.parse(text); } catch { return undefined; }
  const usage = (payload as { usage?: unknown } | null)?.usage as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== "object") return undefined;
  const rolling = window(usage.rolling);
  const weekly = window(usage.weekly);
  if (!rolling || !weekly) return undefined;
  const windows = [rolling, weekly];
  if (usage.monthly !== undefined) {
    const monthly = window(usage.monthly);
    if (!monthly) return undefined;
    windows.push(monthly);
  }
  return { windows, receivedAt };
}

export function isExhausted(observation: QuotaObservation): boolean {
  return observation.windows.some((entry) => entry.exhausted);
}

/** The most restrictive window decides; windows are never added together. */
export function remaining(observation: QuotaObservation): number {
  return Math.min(...observation.windows.map((entry) => entry.remaining));
}

export function nextReset(observation: QuotaObservation): number | null {
  const resets = observation.windows.flatMap((entry) => entry.resetsAt === null ? [] : [entry.resetsAt]);
  return resets.length === 0 ? null : Math.min(...resets);
}

async function readLimited(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel().catch(() => {}); return ""; }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function queryQuota(
  apiKey: string,
  options: { fetch: typeof fetch; signal?: AbortSignal; now: () => number; timeoutMs?: number },
): Promise<QuotaResult> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 5000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  try {
    const response = await options.fetch(usageUrl, {
      method: "GET",
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
      redirect: "error",
      signal,
    });
    if (response.status === 401) { await response.body?.cancel().catch(() => {}); return { kind: "unauthorized" }; }
    if (!response.ok) { await response.body?.cancel().catch(() => {}); return { kind: "failed" }; }
    const text = await readLimited(response, maxBody);
    const observation = parseUsage(text, options.now());
    return observation ? { kind: "ok", observation } : { kind: "failed" };
  } catch {
    // Messages from fetch can embed request details; callers get only a class.
    return { kind: "failed" };
  }
}
