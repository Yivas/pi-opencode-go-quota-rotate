import { isMainThread, workerData } from "node:worker_threads";
import { checkCancellation, StorageError } from "./errors.ts";
import { runStorage } from "./process.ts";
import type { NativeRequest } from "./process.ts";
import type { NativeStorageApi } from "./win32-native.cjs";

let native: Promise<NativeStorageApi> | undefined;

export async function windowsProtection(request: NativeRequest, signal?: AbortSignal): Promise<string | null> {
  checkCancellation(signal);
  if (process.platform !== "win32" || process.arch !== "x64") throw new StorageError("unavailable");
  if (isMainThread || workerData?.ownedStorageWorker !== true) return runStorage({ kind: "native", request }, undefined, signal);
  // Only the disposable helper's worker enters FFI. Its main thread retains a
  // live deadline/EOF handler even while this thread is blocked in native code.
  try {
    native ??= import("./win32-native.cjs").then((module) => module.nativeApi());
    const api = await native;
    if (request.operation === "directory" || request.operation === "file") return api[request.operation](request.path);
    return api.crypt(request.operation, request.data);
  } catch { throw new StorageError("unavailable"); }
}
