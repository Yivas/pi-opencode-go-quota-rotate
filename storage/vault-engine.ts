import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { checkCancellation, isCancellation, StorageError } from "./errors.ts";
import { windowsProtection } from "./win32.ts";
import { acquireFileLock } from "./file-lock.ts";

import { accountsFrom } from "./accounts.ts";
import type { StoredAccount } from "./accounts.ts";

const maxFileBytes = 65536;
const domain = Buffer.from("pi-opencode-go-quota-rotate:vault:1");

function decoded(value: unknown, maximum: number): Buffer {
  if (typeof value !== "string" || value.length > maximum * 2) throw new StorageError("corrupt");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > maximum || bytes.toString("base64") !== value) throw new StorageError("corrupt");
  return bytes;
}

export class VaultEngine {
  readonly root: string;
  constructor(root: string) { this.root = resolve(root); }

  async initialize(signal?: AbortSignal): Promise<void> {
    await windowsProtection({ operation: "directory", path: this.root }, signal);
    const stat = await lstat(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new StorageError("unavailable");
  }

  async read(signal?: AbortSignal): Promise<StoredAccount[]> {
    return this.locked("read", () => this.readCurrent(signal), signal);
  }

  async modify(change: (current: StoredAccount[]) => StoredAccount[] | Promise<StoredAccount[]>, signal?: AbortSignal): Promise<StoredAccount[]> {
    return this.locked("write", async () => {
      const next = accountsFrom(await change(await this.readCurrent(signal)));
      checkCancellation(signal);
      await this.writeCurrent(next, signal);
      return next;
    }, signal);
  }

  private async locked<T>(kind: "read" | "write", operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.initialize(signal);
    const release = await acquireFileLock(join(this.root, "write.lock"), signal);
    let result: T;
    try {
      checkCancellation(signal);
      result = await operation();
    } catch (error) {
      // Preserve the primary failure while still closing the native handle.
      try { release(); } catch { /* The primary failure already blocks managed requests. */ }
      if (error instanceof StorageError || isCancellation(error)) throw error;
      throw new StorageError("unavailable");
    }
    try { release(); } catch { throw new StorageError("lock_release", kind); }
    return result;
  }

  private async readCurrent(signal?: AbortSignal): Promise<StoredAccount[]> {
    const path = join(this.root, "accounts.json");
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxFileBytes) throw new StorageError("corrupt");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    await windowsProtection({ operation: "file", path }, signal);
    const file = await open(path, "r");
    const buffer = Buffer.alloc(maxFileBytes + 1);
    let key: Buffer | undefined;
    let plaintext: Buffer | undefined;
    try {
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        checkCancellation(signal);
        const chunk = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (chunk.bytesRead === 0) break;
        bytesRead += chunk.bytesRead;
      }
      if (bytesRead > maxFileBytes) throw new StorageError("corrupt");
      let parsed: unknown;
      try { parsed = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")); }
      catch { throw new StorageError("corrupt"); }
      if (!parsed || typeof parsed !== "object" || !("version" in parsed) || parsed.version !== 1
        || Object.keys(parsed).sort().join(",") !== "ciphertext,nonce,tag,version,wrappedKey") {
        throw new StorageError("corrupt");
      }
      const envelope = parsed as Record<string, unknown>;
      const nonce = decoded(envelope.nonce, 12);
      const tag = decoded(envelope.tag, 16);
      const ciphertext = decoded(envelope.ciphertext, 32768);
      const wrapped = decoded(envelope.wrappedKey, 16384);
      if (nonce.length !== 12 || tag.length !== 16 || wrapped.length === 0) throw new StorageError("corrupt");
      key = decoded(await windowsProtection({ operation: "unprotect", data: wrapped.toString("base64") }, signal), 32);
      if (key.length !== 32) throw new StorageError("corrupt");
      checkCancellation(signal);
      let pending: Buffer | undefined;
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, nonce);
        decipher.setAAD(domain);
        decipher.setAuthTag(tag);
        pending = decipher.update(ciphertext);
        plaintext = Buffer.concat([pending, decipher.final()]);
        return accountsFrom(JSON.parse(plaintext.toString("utf8")));
      } catch {
        throw new StorageError("corrupt");
      } finally { pending?.fill(0); }
    } finally {
      key?.fill(0);
      plaintext?.fill(0);
      buffer.fill(0);
      await file.close();
    }
  }

  private async writeCurrent(accounts: StoredAccount[], signal?: AbortSignal): Promise<void> {
    const plaintext = Buffer.from(JSON.stringify(accounts));
    if (plaintext.length > 32768) { plaintext.fill(0); throw new StorageError("unavailable"); }
    const key = randomBytes(32);
    const nonce = randomBytes(12);
    const temporary = join(this.root, `${randomUUID()}.tmp`);
    try {
      const wrappedKey = await windowsProtection({ operation: "protect", data: key.toString("base64") }, signal);
      if (typeof wrappedKey !== "string") throw new StorageError("unavailable");
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(domain);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const envelope = Buffer.from(JSON.stringify({
        version: 1,
        wrappedKey,
        nonce: nonce.toString("base64"),
        ciphertext: ciphertext.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
      }));
      if (envelope.length > maxFileBytes) throw new StorageError("unavailable");
      const file = await open(temporary, "wx", 0o600);
      try {
        await windowsProtection({ operation: "file", path: temporary }, signal);
        await file.writeFile(envelope);
        await file.sync();
      } finally { await file.close(); }
      checkCancellation(signal);
      await rename(temporary, join(this.root, "accounts.json"));
    } finally {
      key.fill(0);
      plaintext.fill(0);
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
    }
  }
}
