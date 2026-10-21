import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { acquireFileLock } from "../../storage/file-lock.ts";

// Test-only lock owner. Unlike the storage helper it has no deadline, so it can
// outlive a contender's bounded wait. It takes the same range the vault takes.
if (isMainThread) {
  const root = process.argv[2];
  if (!root || !process.send) throw new Error("This fixture needs its own vault and IPC channel");
  // The event loop stays free to report readiness and to die on demand.
  const worker = new Worker(fileURLToPath(import.meta.url), { workerData: { root, ownedStorageWorker: true } });
  worker.once("message", (message: unknown) => {
    if ((message as { type?: unknown } | null)?.type !== "locked") throw new Error("Fixture worker did not lock the vault");
    process.send?.({ type: "locked" });
    setInterval(() => {}, 1000);
  });
  worker.once("error", (error) => { throw error; });
} else {
  // Never released on purpose: the test kills this process, the way a crashed
  // owner disappears, and Windows releases the range with it.
  await acquireFileLock(join(workerData.root, "write.lock"));
  parentPort?.postMessage({ type: "locked" });
}
