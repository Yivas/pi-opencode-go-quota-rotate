import { isExhausted, queryQuota } from "./quota.ts";
import type { QuotaObservation } from "./quota.ts";
import { choose, isFresh } from "./selection.ts";
import type { StoredAccount } from "./storage/accounts.ts";
import { messages } from "./locales/en.ts";

export const queryIntervalMs = 60_000;
const selectionDeadlineMs = 10_000;

interface Entry {
  observation?: QuotaObservation;
  excluded: boolean;
  rejected: boolean;
  lastQuery: number;
  inflight?: Promise<void>;
}

export interface TransportDeps {
  accounts(signal?: AbortSignal): Promise<StoredAccount[]>;
  now(): number;
  fetch?: typeof fetch;
}

type FetchLike = typeof fetch;

export interface AccountStatus {
  id: string;
  label: string;
  enabled: boolean;
  active: boolean;
  rejected: boolean;
  excluded: boolean;
  observation?: QuotaObservation;
}

/**
 * Quota state and request signing for managed Go requests. Selection reads the
 * current protected accounts for every operation; nothing here is persisted.
 */
/**
 * Bumped whenever ManagedTransport's methods change. The instance outlives a
 * /reload, so a session upgraded in place must not reuse an older object.
 */
export const transportRevision = 2;

export class ManagedTransport {
  readonly revision = transportRevision;
  readonly #deps: TransportDeps;
  readonly #entries = new Map<string, Entry>();
  #activeId: string | undefined;

  constructor(deps: TransportDeps) { this.#deps = deps; }

  #entry(id: string): Entry {
    let entry = this.#entries.get(id);
    if (!entry) { entry = { excluded: false, rejected: false, lastQuery: Number.NEGATIVE_INFINITY }; this.#entries.set(id, entry); }
    return entry;
  }

  /** At most one query per account every 60 seconds; concurrent callers share it. */
  #refresh(account: StoredAccount, base: FetchLike, signal: AbortSignal): Promise<void> {
    const entry = this.#entry(account.id);
    if (entry.inflight) return entry.inflight;
    const now = this.#deps.now();
    // A backwards clock jump is treated as a fresh interval, not as a permanent block.
    if (now >= entry.lastQuery && now - entry.lastQuery < queryIntervalMs) return Promise.resolve();
    entry.lastQuery = now;
    const query = queryQuota(account.apiKey, { fetch: base, signal, now: () => this.#deps.now() }).then((result) => {
      if (result.kind === "ok") {
        entry.observation = result.observation;
        // Passing a reset does not clear an exclusion; a reliable recovery does.
        entry.excluded = isExhausted(result.observation);
      } else if (result.kind === "unauthorized") entry.rejected = true;
      // A usage 200 must not reopen a key the chat endpoint rejected with 401.
      if (result.kind === "ok" && entry.rejected) entry.excluded = true;
    }).finally(() => { entry.inflight = undefined; });
    entry.inflight = query;
    return query;
  }

  #candidates(accounts: StoredAccount[]) {
    return accounts.filter((entry) => entry.enabled && !this.#entry(entry.id).rejected)
      .map((entry) => ({ id: entry.id, observation: this.#entry(entry.id).observation, excluded: this.#entry(entry.id).excluded }));
  }

  async select(accounts: StoredAccount[], base: FetchLike, signal: AbortSignal, avoid?: string): Promise<StoredAccount | undefined> {
    const pool = accounts.filter((entry) => entry.id !== avoid);
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(selectionDeadlineMs)]);
    const now = this.#deps.now();
    // Only accounts without a valid observation are queried; the set is fixed here.
    const stale = pool.filter((entry) => entry.enabled && !this.#entry(entry.id).rejected && !isFresh(this.#entry(entry.id).observation, now));
    await Promise.all(stale.map((entry) => this.#refresh(entry, base, deadline)));
    if (deadline.aborted) return undefined;
    const id = choose(this.#candidates(pool), this.#activeId === avoid ? undefined : this.#activeId, this.#deps.now());
    if (id) this.#activeId = id;
    return pool.find((entry) => entry.id === id);
  }

  /** The 429 is confirmed only when a fresh usage reading shows the account exhausted. */
  async confirmExhausted(account: StoredAccount, base: FetchLike, signal: AbortSignal): Promise<boolean> {
    const entry = this.#entry(account.id);
    const before = entry.observation;
    // The 60-second cadence still applies: inside it nothing new is learned,
    // so the 429 stays unconfirmed and the original response goes back.
    await this.#refresh(account, base, AbortSignal.any([signal, AbortSignal.timeout(5000)]));
    const exhausted = entry.observation !== before && entry.observation !== undefined && isExhausted(entry.observation);
    if (exhausted) entry.excluded = true;
    return exhausted;
  }

  /**
   * Status for every account, for display only. Stale readings are refreshed
   * under the same once-a-minute rule as selection; nothing is selected here.
   */
  async status(accounts: StoredAccount[], base: FetchLike, signal: AbortSignal): Promise<AccountStatus[]> {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(selectionDeadlineMs)]);
    const now = this.#deps.now();
    // A key the server rejected is not queried again; it would only fail again.
    await Promise.all(accounts.filter((entry) => entry.enabled && !this.#entry(entry.id).rejected && !isFresh(this.#entry(entry.id).observation, now))
      .map((entry) => this.#refresh(entry, base, deadline)));
    return accounts.map((account) => {
      const entry = this.#entry(account.id);
      return {
        id: account.id,
        label: account.label,
        enabled: account.enabled,
        active: account.id === this.#activeId,
        rejected: entry.rejected,
        excluded: entry.excluded,
        observation: entry.observation,
      };
    });
  }

  reject(account: StoredAccount): void { this.#entry(account.id).rejected = true; }

  /**
   * One fetch for one request: at most two sends (the account and, only after
   * confirmed exhaustion, one alternate). SDK retries pass through here too.
   */
  signedFetch(accounts: StoredAccount[], first: StoredAccount, base: FetchLike, signal: AbortSignal, take: () => void = () => {}): FetchLike {
    let current = first;
    let sends = 0;
    return async (input, init) => {
      for (;;) {
        sends++;
        if (sends > 2) throw new Error(messages.attemptLimit);
        take();
        const headers = new Headers(init?.headers);
        headers.set("authorization", `Bearer ${current.apiKey}`);
        headers.set("x-api-key", current.apiKey);
        // Never follow a redirect with the key attached, whichever header the SDK reads.
        const response = await base(input, { ...init, headers, redirect: "error" });
        if (response.status === 401) { this.reject(current); return response; }
        if (response.status !== 429 || sends > 1) return response;
        if (!(await this.confirmExhausted(current, base, signal))) return response;
        const alternate = await this.select(accounts, base, signal, current.id);
        if (!alternate) return response;
        // The first response is abandoned unread; none of its content reached the host.
        await response.body?.cancel().catch(() => {});
        current = alternate;
      }
    };
  }
}
