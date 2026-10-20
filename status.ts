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

/** One line per account. Names and usage only; keys never reach this function. */
export function formatStatus(accounts: AccountStatus[], now: number): string {
  if (accounts.length === 0) return messages.accountsEmpty;
  const lines = accounts.map((account) => {
    const parts = [`${account.active && account.enabled ? "▸" : " "} ${account.label}`];
    if (!account.enabled) parts.push(messages.statusDisabled);
    else if (account.rejected) parts.push(messages.statusRejected);
    else if (!account.observation) parts.push(messages.statusUnknown);
    // An expired reading (older than a minute or past a reset) says nothing about now.
    else if (!isFresh(account.observation, now)) parts.push(messages.statusStale);
    else {
      if (account.excluded || isExhausted(account.observation)) parts.push(messages.statusExhausted);
      for (const window of account.observation.windows) {
        const reset = window.resetsAt === null ? "" : ` (${messages.statusResets} ${when(window.resetsAt, now)})`;
        // A rate-limited window has no usable room, whatever its percentage says.
        parts.push(`${window.name} ${window.exhausted ? 0 : Math.round(window.remaining)}% ${messages.statusLeft}${reset}`);
      }
      parts.push(`${messages.statusRead} ${Math.max(0, Math.round((now - account.observation.receivedAt) / 1000))}s ${messages.statusAgo}`);
    }
    return parts.join(" · ");
  });
  return [messages.statusTitle, ...lines].join("\n");
}
