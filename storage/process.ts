import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { accountsFrom } from "./accounts.ts";
import type { StoredAccount } from "./accounts.ts";
import { AccountError, cancellationError, checkCancellation, isCancellation, StorageError } from "./errors.ts";

export type NativeRequest = { operation: "directory" | "file"; path: string }
  | { operation: "protect" | "unprotect"; data: string };
export type VaultJob = { kind: "read" | "modify"; root: string };
export type NativeJob = { kind: "native"; request: NativeRequest };
export type StorageJob = VaultJob | NativeJob;
type Change = (current: StoredAccount[]) => StoredAccount[] | Promise<StoredAccount[]>;

export function runStorage(job: VaultJob, change?: Change, signal?: AbortSignal): Promise<StoredAccount[]>;
export function runStorage(job: NativeJob, change?: undefined, signal?: AbortSignal): Promise<string | null>;
export function runStorage(job: StorageJob, change?: Change, signal?: AbortSignal): Promise<StoredAccount[] | string | null> {
  try { checkCancellation(signal); } catch (error) { return Promise.reject(error); }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./win32-worker.cjs", import.meta.url))], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
      env: { PATH: dirname(process.execPath), SystemRoot: process.env.SystemRoot ?? "C:\\Windows" },
    });
    const closed = new Promise<void>((finish) => child.once("close", () => finish()));
    let phase: "starting" | "changing" | "committing" | "result" = "starting";
    let settled = false;
    let input = "";
    let bytes = 0;
    let result: { data: StoredAccount[] | string | null } | undefined;
    const timer = setTimeout(() => fail(new StorageError("unavailable")), 6000);
    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      input = "";
    }
    function fail(error: unknown) {
      if (settled) return;
      settled = true;
      child.kill();
      cleanup();
      // A validated result frame is the acknowledgement. Late teardown trouble
      // (deadline, EOF noise) must not turn a committed success into a failure.
      if (phase === "result" && result && !(error instanceof StorageError) && !(error instanceof AccountError) && !isCancellation(error)) {
        const acknowledged = result.data;
        void settleAfterExit(() => resolve(acknowledged as never));
        return;
      }
      const failure = job.kind === "modify" && (phase === "committing" || phase === "result")
        && !(error instanceof StorageError && error.committed === true)
        ? new StorageError("indeterminate")
        : error instanceof StorageError || error instanceof AccountError || isCancellation(error) ? error : new StorageError("unavailable");
      // A rejected promise alone is not cancellation: wait for the helper's
      // actual exit before returning control and releasing its OS-owned locks.
      void settleAfterExit(() => reject(failure));
    }
    // Bounded: if Windows never reports the exit, still answer and keep storage
    // closed to the caller. The disposable helper owns no other work.
    function settleAfterExit(finish: () => void): Promise<void> {
      return Promise.race([closed, new Promise<void>((done) => setTimeout(done, 2000))]).then(finish);
    }
    function abort() { fail(cancellationError()); }
    function receive(value: unknown) {
      if (!value || typeof value !== "object" || !("type" in value)) throw new StorageError("unavailable");
      const reply = value as Record<string, unknown>;
      if (reply.type === "ready" && job.kind === "modify" && phase === "starting" && change) {
        const current = accountsFrom(reply.data);
        phase = "changing";
        Promise.resolve().then(() => change(current)).then((next) => {
          if (settled) return;
          checkCancellation(signal);
          const encoded = JSON.stringify({ type: "commit", data: accountsFrom(next) }) + "\n";
          if (Buffer.byteLength(encoded) > 65536) throw new StorageError("unavailable");
          phase = "committing";
          child.stdin.write(encoded);
        }).catch(fail);
      } else if (reply.type === "result" && (job.kind === "modify" ? phase === "committing" : phase === "starting")) {
        const data = job.kind === "native" ? reply.data : accountsFrom(reply.data);
        if (data !== null && typeof data !== "string" && !Array.isArray(data)) throw new StorageError("unavailable");
        if (job.kind === "native" && data !== null && typeof data !== "string") throw new StorageError("unavailable");
        result = { data: data as StoredAccount[] | string | null };
        phase = "result";
      } else if (reply.type === "error" && ["unavailable", "corrupt", "lock_release"].includes(String(reply.code))) {
        const code = reply.code as "unavailable" | "corrupt" | "lock_release";
        fail(new StorageError(code, reply.committed === true && job.kind === "modify" ? "write" : undefined));
      } else throw new StorageError("unavailable");
    }
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    child.on("error", fail);
    child.stdin.on("error", fail);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (settled) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > 131072) { fail(new StorageError("unavailable")); return; }
      input += chunk;
      try {
        for (;;) {
          const end = input.indexOf("\n");
          if (end < 0) break;
          const line = input.slice(0, end);
          input = input.slice(end + 1);
          if (Buffer.byteLength(line) > 65536) throw new StorageError("unavailable");
          receive(JSON.parse(line));
          if (settled) return;
        }
      } catch (error) { fail(error); }
    });
    child.on("close", () => {
      if (settled) return;
      // A complete, validated result ACK follows commit and lock release. The
      // disposable helper deliberately self-terminates after flushing that ACK.
      if (!result || input.length !== 0) { fail(new StorageError("unavailable")); return; }
      settled = true;
      cleanup();
      resolve(result.data);
    });
    const encoded = JSON.stringify(job) + "\n";
    if (Buffer.byteLength(encoded) > 65536) { fail(new StorageError("unavailable")); return; }
    child.stdin.write(encoded);
  });
}
