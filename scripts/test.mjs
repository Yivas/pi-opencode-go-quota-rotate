import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const sandbox = mkdtempSync(join(tmpdir(), "go-rotation-test-"));
const agent = join(sandbox, "agent");
mkdirSync(agent);
const env = {
  PATH: dirname(process.execPath),
  HOME: sandbox,
  USERPROFILE: sandbox,
  APPDATA: sandbox,
  LOCALAPPDATA: sandbox,
  TEMP: sandbox,
  TMP: sandbox,
  PI_CODING_AGENT_DIR: agent,
  PI_OFFLINE: "1",
  ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot ?? "C:\\Windows" } : {}),
};
try {
  const result = spawnSync(process.execPath, ["--test", "test/plugin.test.ts", "test/storage.test.ts", "test/transport.test.ts"], {
    env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}
