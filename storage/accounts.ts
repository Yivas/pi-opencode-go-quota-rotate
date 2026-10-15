import { StorageError } from "./errors.ts";

export interface StoredAccount {
  id: string;
  label: string;
  apiKey: string;
  enabled: boolean;
}


export function accountsFrom(value: unknown): StoredAccount[] {
  if (!Array.isArray(value) || value.length > 32) throw new StorageError("corrupt");
  const ids = new Set<string>();
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Object.keys(entry).sort().join(",") !== "apiKey,enabled,id,label"
      || typeof entry.id !== "string" || !/^[a-zA-Z0-9_-]{8,80}$/.test(entry.id)
      || ids.has(entry.id) || typeof entry.label !== "string" || entry.label.length < 1 || entry.label.length > 80
      || /\p{Cc}/u.test(entry.label) || typeof entry.apiKey !== "string"
      || !/^[\x21-\x7e]{1,8192}$/.test(entry.apiKey) || typeof entry.enabled !== "boolean") {
      throw new StorageError("corrupt");
    }
    ids.add(entry.id);
    return { id: entry.id, label: entry.label, apiKey: entry.apiKey, enabled: entry.enabled };
  });
}
