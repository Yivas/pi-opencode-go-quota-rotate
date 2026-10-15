// Test-only control of the external filesystem boundary in an owned helper.
// No Pi/SDK code or application collaborator is replaced.
import filesystem from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { isMainThread } from "node:worker_threads";

if (!isMainThread) {
  const mode = process.env.GO_STORAGE_TEST_FAULT;
  const open = filesystem.open;
  const rename = filesystem.rename;
  if (mode === "block") {
    const { default: koffi } = await import("koffi");
    const kernel = koffi.load("kernel32.dll");
    const sleep = kernel.func("void __stdcall Sleep(uint32_t milliseconds)");
    filesystem.open = async (...args) => {
      if (String(args[0]).endsWith("accounts.json")) {
        writeFileSync(process.env.GO_STORAGE_TEST_MARKER, "blocked");
        sleep(30000);
      }
      return open(...args);
    };
  } else if (mode === "before" || mode === "after") {
    filesystem.rename = async (...args) => {
      if (String(args[1]).endsWith("accounts.json")) {
        if (mode === "before") process.exit(23);
        await rename(...args);
        process.exit(24);
      }
      return rename(...args);
    };
  }
  syncBuiltinESMExports();
}
