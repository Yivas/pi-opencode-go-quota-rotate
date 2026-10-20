import { messages } from "./locales/en.ts";
import { isExhausted } from "./quota.ts";
import { isFresh } from "./selection.ts";
import type { AccountStatus } from "./transport.ts";

function when(time: number, now: number): string {
  const date = new Date(time);
  const sameDay = new Date(now).toDateString() === date.toDateString();
  return sameDay
    ? date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const windowNames = { "5h": messages.window5h, week: messages.windowWeek, month: messages.windowMonth } as const;

/** Name and usage for one account. Keys never reach this function. */
export function describeAccount(account: AccountStatus, now: number): { title: string; detail: string } {
  const title = `${account.active && account.enabled ? "▸" : " "} ${account.label}`;
  if (!account.enabled) return { title, detail: messages.statusDisabled };
  if (account.rejected) return { title, detail: messages.statusRejected };
  if (!account.observation) return { title, detail: messages.statusUnknown };
  // An expired reading (older than a minute or past a reset) says nothing about now.
  if (!isFresh(account.observation, now)) return { title, detail: messages.statusStale };
  const parts: string[] = [];
  if (account.excluded || isExhausted(account.observation)) parts.push(messages.statusExhausted);
  for (const window of account.observation.windows) {
    const reset = window.resetsAt === null ? "" : ` (${messages.statusResets} ${when(window.resetsAt, now)})`;
    // A rate-limited window has no usable room, whatever its percentage says.
    parts.push(`${windowNames[window.name]} ${window.exhausted ? 0 : Math.round(window.remaining)}% ${messages.statusLeft}${reset}`);
  }
  parts.push(`${messages.statusRead} ${Math.max(0, Math.round((now - account.observation.receivedAt) / 1000))}s ${messages.statusAgo}`);
  return { title, detail: parts.join(" · ") };
}

/** Plain-text summary for modes without the interactive panel. */
export function formatStatus(accounts: AccountStatus[], now: number): string {
  if (accounts.length === 0) return messages.accountsEmpty;
  const lines = accounts.map((account) => {
    const { title, detail } = describeAccount(account, now);
    return `${title} · ${detail}`;
  });
  return [messages.statusTitle, ...lines].join("\n");
}
