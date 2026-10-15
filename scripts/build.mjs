import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
rmSync(join(root, "dist"), { recursive: true, force: true });
const tsc = spawnSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.build.json"], { cwd: root, stdio: "inherit" });
if (tsc.status !== 0) process.exit(tsc.status ?? 1);
// tsc does not copy plain CommonJS helpers; they run in the disposable child process.
mkdirSync(join(root, "dist/storage"), { recursive: true });
for (const file of ["win32-worker.cjs", "win32-native.cjs"]) copyFileSync(join(root, "storage", file), join(root, "dist/storage", file));
