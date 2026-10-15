import { isExhausted, nextReset, remaining } from "./quota.ts";
import type { QuotaObservation } from "./quota.ts";

export const observationTtlMs = 60_000;

export interface Candidate {
  id: string;
  observation?: QuotaObservation;
  /** Confirmed exhaustion stays until a later reliable observation shows recovery. */
  excluded: boolean;
}

/** Valid below 60 seconds and until the earliest known reset. A clock jump invalidates it. */
export function isFresh(observation: QuotaObservation | undefined, now: number): observation is QuotaObservation {
  if (!observation) return false;
  const age = now - observation.receivedAt;
  if (age < 0 || age >= observationTtlMs) return false;
  const reset = nextReset(observation);
  return reset === null || now < reset;
}

function usable(candidate: Candidate, now: number): boolean {
  return !candidate.excluded && isFresh(candidate.observation, now) && !isExhausted(candidate.observation);
}

/**
 * Keep the active account while it is known usable. Otherwise take the known
 * usable one with the most capacity in its tightest window; ties go to the
 * nearest known reset, then the stable ID. With no known usable account, only
 * an unknown (never confirmed exhausted) active account may be tried.
 */
export function choose(candidates: Candidate[], activeId: string | undefined, now: number): string | undefined {
  const active = candidates.find((entry) => entry.id === activeId);
  if (active && usable(active, now)) return active.id;
  const known = candidates.filter((entry) => usable(entry, now));
  if (known.length > 0) {
    known.sort((a, b) => {
      const byCapacity = remaining(b.observation as QuotaObservation) - remaining(a.observation as QuotaObservation);
      if (byCapacity !== 0) return byCapacity;
      const ra = nextReset(a.observation as QuotaObservation);
      const rb = nextReset(b.observation as QuotaObservation);
      if (ra !== rb) return ra === null ? 1 : rb === null ? -1 : ra - rb;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    return known[0]?.id;
  }
  if (active && !active.excluded && !isFresh(active.observation, now)) return active.id;
  return undefined;
}
