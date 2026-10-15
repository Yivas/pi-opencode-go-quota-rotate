"use strict";

if (require.main !== module) throw new Error("Storage helper must run as its own process");

const path = require("node:path");
const { Worker } = require("node:worker_threads");

// This event loop never calls FFI. It can terminate the whole helper even
// while its worker is blocked inside a native function.
// Self-termination avoids process.exit() joining a worker stuck in native code.
// This entry is only spawned as our disposable child, never imported by Pi.
function terminate() { process.kill(process.pid, "SIGKILL"); }

let worker;
let phase = "starting";
let input = "";
let bytes = 0;
const deadline = setTimeout(() => terminate(), 5000);
process.stdin.setEncoding("utf8");
process.stdin.on("end", () => terminate());
process.stdin.on("error", () => terminate());
process.stdout.on("error", () => terminate());

function finish(message) {
  if (phase === "done") return;
  phase = "done";
  const encoded = JSON.stringify(message) + "\n";
  if (Buffer.byteLength(encoded) > 65536) return terminate();
  process.stdout.write(encoded, () => {
    clearTimeout(deadline);
    // The result frame is the ACK. After flushing it, terminate without
    // joining native worker teardown; no file writes remain at this point.
    terminate();
  });
}

function receive(message) {
  if (!worker) {
    if (!message || !["read", "modify", "native"].includes(message.kind)) return terminate();
    if (message.kind !== "native" && typeof message.root !== "string") return terminate();
    if (message.kind === "native" && (!message.request
      || !["directory", "file", "protect", "unprotect"].includes(message.request.operation))) return terminate();
    worker = new Worker(path.join(__dirname, require("node:fs").existsSync(path.join(__dirname, "vault-thread.js")) ? "vault-thread.js" : "vault-thread.ts"), { workerData: { job: message, ownedStorageWorker: true } });
    worker.on("error", () => terminate());
    worker.on("exit", () => { if (phase !== "done") terminate(); });
    worker.on("message", (reply) => {
      if (!reply || typeof reply !== "object") return terminate();
      if (reply.type === "ready" && message.kind === "modify" && phase === "starting") {
        phase = "waiting";
        const encoded = JSON.stringify(reply) + "\n";
        if (Buffer.byteLength(encoded) > 65536) return terminate();
        process.stdout.write(encoded);
      } else if (reply.type === "error" || (reply.type === "result"
        && (message.kind === "modify" ? phase === "writing" : phase === "starting"))) {
        finish(reply);
      } else terminate();
    });
    return;
  }
  if (phase !== "waiting" || message?.type !== "commit") return terminate();
  phase = "writing";
  worker.postMessage(message);
}

process.stdin.on("data", (chunk) => {
  bytes += Buffer.byteLength(chunk);
  if (bytes > 131072) return terminate();
  input += chunk;
  for (;;) {
    const end = input.indexOf("\n");
    if (end < 0) break;
    const line = input.slice(0, end);
    input = input.slice(end + 1);
    try { receive(JSON.parse(line)); } catch { terminate(); }
  }
});
