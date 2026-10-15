import { resolve } from "node:path";
import { runStorage } from "./process.ts";
import { windowsProtection } from "./win32.ts";
import type { StoredAccount } from "./accounts.ts";

export type { StoredAccount } from "./accounts.ts";

// No FFI or credential-file I/O runs in the host. One disposable helper owns
// the entire transaction, including its lock, authentication and final rename.
export class AccountVault {
  readonly root: string;
  constructor(root: string) { this.root = resolve(root); }

  async initialize(signal?: AbortSignal): Promise<void> {
    await windowsProtection({ operation: "directory", path: this.root }, signal);
  }

  read(signal?: AbortSignal): Promise<StoredAccount[]> {
    return runStorage({ kind: "read", root: this.root }, undefined, signal);
  }

  // The callback only transforms account data. External effects and user
  // interaction must happen before opening this bounded transaction.
  modify(change: (current: StoredAccount[]) => StoredAccount[] | Promise<StoredAccount[]>, signal?: AbortSignal): Promise<StoredAccount[]> {
    return runStorage({ kind: "modify", root: this.root }, change, signal);
  }
}
