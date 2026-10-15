import { randomUUID } from "node:crypto";
import { AccountError } from "./errors.ts";
import { messages } from "../locales/en.ts";
import type { StoredAccount } from "./accounts.ts";
import type { AccountVault } from "./vault.ts";

export interface AccountSummary {
  id: string;
  label: string;
  enabled: boolean;
}

export function validAccountInput(label: string, key: string): { label: string; key: string } {
  const cleanLabel = label.trim();
  const cleanKey = key.trim();
  if (cleanLabel.length < 1 || cleanLabel.length > 80 || /\p{Cc}/u.test(cleanLabel)
    || !/^[\x21-\x7e]{1,8192}$/.test(cleanKey)) {
    throw new AccountError(messages.accountInvalid);
  }
  return { label: cleanLabel, key: cleanKey };
}

export async function addAccount(vault: AccountVault, label: string, key: string, signal?: AbortSignal): Promise<void> {
  const input = validAccountInput(label, key);
  await vault.modify((current) => {
    if (current.some((entry) => entry.apiKey === input.key)) throw new AccountError(messages.accountDuplicate);
    return [...current, { id: randomUUID(), label: input.label, apiKey: input.key, enabled: true }];
  }, signal);
}

export async function listAccounts(vault: AccountVault, signal?: AbortSignal): Promise<AccountSummary[]> {
  // Keys never leave this function; menus and notices only get names and state.
  return (await vault.read(signal)).map(({ id, label, enabled }) => ({ id, label, enabled }));
}

function change(vault: AccountVault, id: string, edit: (current: StoredAccount[]) => StoredAccount[], signal?: AbortSignal) {
  return vault.modify((current) => {
    if (!current.some((entry) => entry.id === id)) throw new AccountError(messages.accountMissing);
    return edit(current);
  }, signal);
}

export async function setAccountEnabled(vault: AccountVault, id: string, enabled: boolean, signal?: AbortSignal): Promise<void> {
  await change(vault, id, (current) => current.map((entry) => entry.id === id ? { ...entry, enabled } : entry), signal);
}

export async function removeAccount(vault: AccountVault, id: string, signal?: AbortSignal): Promise<void> {
  await change(vault, id, (current) => current.filter((entry) => entry.id !== id), signal);
}
