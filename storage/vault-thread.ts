import { once } from "node:events";
import { parentPort, workerData } from "node:worker_threads";
import { accountsFrom } from "./accounts.ts";
import { StorageError } from "./errors.ts";
import type { StorageJob } from "./process.ts";
import { VaultEngine } from "./vault-engine.ts";
import { windowsProtection } from "./win32.ts";

const port = parentPort;
if (!port || workerData?.ownedStorageWorker !== true) throw new Error("Invalid storage worker");
const job = workerData.job as StorageJob;

async function run(channel: NonNullable<typeof parentPort>) {
  if (job.kind === "native") return windowsProtection(job.request);
  const vault = new VaultEngine(job.root);
  if (job.kind === "read") return vault.read();
  if (job.kind !== "modify") throw new StorageError("unavailable");
  return vault.modify(async (current) => {
    const committed = once(channel, "message");
    channel.postMessage({ type: "ready", data: current });
    const [reply] = await committed;
    if (reply?.type !== "commit") throw new StorageError("unavailable");
    return accountsFrom(reply.data);
  });
}

void run(port).then((data) => port.postMessage({ type: "result", data })).catch((error: unknown) => {
  const known = error instanceof StorageError ? error : new StorageError("unavailable");
  port.postMessage({ type: "error", code: known.code, committed: known.committed === true });
});
