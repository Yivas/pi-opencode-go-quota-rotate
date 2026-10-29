import { messages } from "./locales/en.ts";
import type { FailureCause } from "./failure.ts";

interface Scope { sends: number; readonly max: number }

/**
 * Authorization for managed sends. The main conversation is open until a step
 * ends in error or cancellation; only a new explicit user input reopens it, so
 * a host retry (new run, new turn) gets nothing. Compaction and branch summaries
 * carry their own signal and their own send budget, independent of the main one.
 */
/** Bumped whenever StepGate's methods change; see transportRevision. */
export const gateRevision = 2;

export class StepGate {
  readonly revision = gateRevision;
  #open = true;
  #failure: FailureCause = { category: "unknown" };
  readonly #scopes = new WeakMap<AbortSignal, Scope>();

  /** Explicit user input (or the retry Pi runs after a successful overflow compaction) reopens the main barrier. */
  reopen(): void {
    this.#open = true;
    this.#failure = { category: "unknown" };
  }

  /** compaction: two summary steps, four sends; branch summary: one step, two sends. */
  scope(signal: AbortSignal, kind: "compaction" | "branch"): void {
    this.#scopes.set(signal, { sends: 0, max: kind === "compaction" ? 4 : 2 });
  }

  /** Called before any send. Returns the per-send budget check and the outcome reporter. */
  authorize(signal: AbortSignal): { take(): void; finish(failed: boolean, cause?: FailureCause): void } {
    const scope = this.#scopes.get(signal);
    if (scope) {
      return {
        take() { if (++scope.sends > scope.max) throw new Error(messages.attemptLimit); },
        finish() {},
      };
    }
    if (!this.#open) throw new Error(messages.barrierClosed(this.#failure));
    return { take() {}, finish: (failed, cause) => {
      if (failed && this.#open) {
        this.#failure = cause ?? { category: "unknown" };
        this.#open = false;
      }
    } };
  }
}
