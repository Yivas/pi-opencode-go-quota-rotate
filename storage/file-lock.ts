import { lstat } from "node:fs/promises";
import { isMainThread, workerData } from "node:worker_threads";
import { checkCancellation, StorageError } from "./errors.ts";

async function loadApi() {
  const { default: koffi } = await import("koffi");
  const kernel = koffi.load("kernel32.dll");
  // Anonymous types remain independent when Pi reloads the extension module.
  const overlapped = koffi.struct({
    Internal: "uintptr_t", InternalHigh: "uintptr_t",
    Offset: "uint32_t", OffsetHigh: "uint32_t", hEvent: "void *",
  });
  if (koffi.sizeof(overlapped) !== 32) throw new StorageError("unavailable");
  return {
    create: kernel.func("__stdcall", "CreateFileW", "void *", ["str16", "uint32_t", "uint32_t", "void *", "uint32_t", "uint32_t", "void *"]),
    lock: kernel.func("__stdcall", "LockFileEx", "int32_t", ["void *", "uint32_t", "uint32_t", "uint32_t", "uint32_t", koffi.inout(koffi.pointer(overlapped))]),
    unlock: kernel.func("__stdcall", "UnlockFileEx", "int32_t", ["void *", "uint32_t", "uint32_t", "uint32_t", koffi.pointer(overlapped)]),
    close: kernel.func("int32_t __stdcall CloseHandle(void *handle)"),
  };
}

let apiPromise: ReturnType<typeof loadApi> | undefined;

export async function acquireFileLock(path: string, signal?: AbortSignal): Promise<() => void> {
  checkCancellation(signal);
  if (process.platform !== "win32" || process.arch !== "x64" || isMainThread || workerData?.ownedStorageWorker !== true) {
    throw new StorageError("unavailable");
  }
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new StorageError("unavailable");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new StorageError("unavailable");
  }
  let api: Awaited<ReturnType<typeof loadApi>>;
  try {
    apiPromise ??= loadApi();
    api = await apiPromise;
  }
  catch { throw new StorageError("unavailable"); }
  checkCancellation(signal);
  // OPEN_ALWAYS; share reads/writes but never deletion. Windows releases the
  // handle's exclusive range on process exit; unlike a mutex it is not recursive
  // across separate handles in one Node thread. Never delete/replace this file.
  // https://learn.microsoft.com/windows/win32/api/fileapi/nf-fileapi-lockfileex
  const handle: unknown = api.create(path, 0xc0000000, 3, null, 4, 0x80, null);
  if (typeof handle !== "bigint" || handle === 0n || handle === -1n || handle === 0xffffffffffffffffn) {
    throw new StorageError("unavailable");
  }
  const offset = { Internal: 0, InternalHigh: 0, Offset: 0, OffsetHigh: 0, hEvent: null };
  if (!api.lock(handle, 3, 0, 1, 0, offset)) {
    api.close(handle);
    // No GetLastError inference across FFI: unknown failure stays unavailable,
    // rather than being labelled busy and retried on an invented error code.
    throw new StorageError("unavailable");
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    let unlocked = false;
    let closed = false;
    try { unlocked = api.unlock(handle, 0, 1, 0, offset) !== 0; }
    finally { closed = api.close(handle) !== 0; }
    if (!unlocked || !closed) throw new StorageError("lock_release");
  };
  if (signal?.aborted) { release(); checkCancellation(signal); }
  return release;
}
