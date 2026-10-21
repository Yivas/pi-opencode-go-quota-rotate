import assert from "node:assert/strict";
import childProcess, { spawn } from "node:child_process";
import type { SpawnOptions } from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, readFile, writeFile, mkdir, rm, lstat, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { AccountVault } from "../storage/vault.ts";
import { windowsProtection } from "../storage/win32.ts";

const windows = process.platform === "win32" && process.arch === "x64";

function faultHelper(t: TestContext, mode: "block" | "before" | "after", marker?: string) {
  const original = childProcess.spawn;
  const hook = new URL("./fixtures/storage-fault.mjs", import.meta.url).href;
  const replacement = ((command: string, args: readonly string[] = [], options: SpawnOptions = {}) => {
    if (args[0]?.endsWith("win32-worker.cjs")) {
      return original(command, ["--import", hook, ...args], {
        ...options,
        env: { ...options.env, GO_STORAGE_TEST_FAULT: mode, ...(marker ? { GO_STORAGE_TEST_MARKER: marker } : {}) },
      });
    }
    return original(command, args, options);
  }) as typeof childProcess.spawn;
  const patched = t.mock.method(childProcess, "spawn", replacement);
  syncBuiltinESMExports();
  const restore = () => { patched.mock.restore(); syncBuiltinESMExports(); };
  t.after(restore);
  return restore;
}
function observeHelperExits(t: TestContext): boolean[] {
  const exited: boolean[] = [];
  const original = childProcess.spawn;
  const patched = t.mock.method(childProcess, "spawn", ((command: string, args: readonly string[] = [], options: SpawnOptions = {}) => {
    const child = original(command, args, options);
    if (args[0]?.endsWith("win32-worker.cjs")) {
      const index = exited.push(false) - 1;
      child.once("close", () => { exited[index] = true; });
    }
    return child;
  }) as typeof childProcess.spawn);
  syncBuiltinESMExports();
  t.after(() => { patched.mock.restore(); syncBuiltinESMExports(); });
  return exited;
}

const account = { id: "fixture-account-0001", label: "Synthetic fixture", apiKey: "synthetic-not-a-real-key-12345", enabled: true };

const secondAccount = { id: "fixture-account-0002", label: "Synthetic second fixture", apiKey: "synthetic-not-a-real-key-67890", enabled: true };

async function fixture(t: TestContext) {
  const parent = await mkdtemp(join(tmpdir(), "go-vault-"));
  const root = join(parent, "vault");
  const cleanups: (() => Promise<void>)[] = [];
  // One hook, in order: Node runs after hooks in registration order, so every
  // lock owner must exit before its vault directory can be removed.
  t.after(async () => {
    for (const cleanup of cleanups) await cleanup();
    await rm(parent, { recursive: true, force: true });
  });
  return { parent, root, vault: new AccountVault(root), path: join(root, "accounts.json"), cleanups };
}

async function staysPending(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  await delay(milliseconds);
  return !settled;
}

// A real Windows lock on the vault's range, held by a process with no deadline.
async function holdVault(vaultFixture: { root: string; cleanups: (() => Promise<void>)[] }) {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/hold-vault.ts", import.meta.url)), vaultFixture.root], {
    windowsHide: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: { SystemRoot: process.env.SystemRoot ?? "C:\\Windows", PATH: dirname(process.execPath) },
  });
  const closed = once(child, "close");
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    child.kill();
    await closed;
  };
  vaultFixture.cleanups.push(stop);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const started = await Promise.race([
      once(child, "message"),
      closed.then(() => { throw new Error("Lock holder exited before acquiring its range"); }),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Lock holder did not acquire its range")), 5000); }),
    ]);
    assert.deepEqual(started[0], { type: "locked" });
  } finally { clearTimeout(timer); }
  return { child, stop };
}

test("Windows protection persists a synthetic credential and recovers it without plaintext on disk", { skip: !windows }, async (t) => {
  const { root, vault, path } = await fixture(t);
  assert.deepEqual(await vault.read(), []);
  await vault.modify(() => [account]);
  const saved = await readFile(path, "utf8");
  assert.equal(saved.includes(account.apiKey), false);
  assert.equal(saved.includes(account.label), false);
  assert.deepEqual(await new AccountVault(root).read(), [account]);
});

test("authenticated storage rejects corruption even though DPAPI still unwraps the intact key", { skip: !windows }, async (t) => {
  const { vault, path } = await fixture(t);
  await vault.modify(() => [account]);
  const envelope = JSON.parse(await readFile(path, "utf8"));
  const ciphertext = Buffer.from(envelope.ciphertext, "base64");
  ciphertext[0] ^= 1;
  envelope.ciphertext = ciphertext.toString("base64");
  await writeFile(path, JSON.stringify(envelope));
  await assert.rejects(vault.read(), /could not be authenticated/);
});

test("an existing directory with broader ACLs is rejected without weakening them", { skip: !windows }, async (t) => {
  const { vault, root } = await fixture(t);
  await mkdir(root);
  await assert.rejects(vault.read(), /Protected storage is unavailable/);
  assert.equal((await lstat(root)).isDirectory(), true);
});

test("a competing read waits for an open transaction and returns the committed snapshot", { skip: !windows, timeout: 12000 }, async (t) => {
  const { vault, root, cleanups } = await fixture(t);
  await vault.modify(() => [account]);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let entered: () => void = () => {};
  const enteredChange = new Promise<void>((resolve) => { entered = resolve; });
  const owner = vault.modify(async (current) => { entered(); await held; return [...current, secondAccount]; });
  cleanups.push(async () => { release(); await owner.catch(() => {}); });
  await enteredChange;
  const reading = new AccountVault(root).read();
  assert.equal(await staysPending(reading, 400), true);
  release();
  assert.deepEqual(await reading, [account, secondAccount]);
  await owner;
});

test("a competing write waits for an open transaction and commits on the released vault", { skip: !windows, timeout: 12000 }, async (t) => {
  const { vault, root, cleanups } = await fixture(t);
  await vault.modify(() => [account]);
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let entered: () => void = () => {};
  const enteredChange = new Promise<void>((resolve) => { entered = resolve; });
  const owner = vault.modify(async (current) => { entered(); await held; return [...current, secondAccount]; });
  cleanups.push(async () => { release(); await owner.catch(() => {}); });
  await enteredChange;
  const writing = new AccountVault(root).modify((current) => current.map((entry) => ({ ...entry, enabled: false })));
  assert.equal(await staysPending(writing, 400), true);
  release();
  const disabled = [{ ...account, enabled: false }, { ...secondAccount, enabled: false }];
  assert.deepEqual(await writing, disabled);
  await owner;
  assert.deepEqual(await vault.read(), disabled);
});

test("cancellation rejects native work without creating a credential file", { skip: !windows }, async (t) => {
  const { root, path } = await fixture(t);
  const cancellation = new AbortController();
  const pending = windowsProtection({ operation: "directory", path: root }, cancellation.signal);
  cancellation.abort();
  await assert.rejects(pending, { name: "AbortError" });
  await assert.rejects(lstat(path), { code: "ENOENT" });
});

test("unsupported envelopes and oversized files are rejected before credentials are returned", { skip: !windows }, async (t) => {
  const { vault, path } = await fixture(t);
  await vault.modify(() => [account]);
  const valid = JSON.parse(await readFile(path, "utf8"));
  const variants = [
    { ...valid, version: 2 },
    { ...valid, unexpected: true },
    { ...valid, nonce: Buffer.alloc(11).toString("base64") },
    { ...valid, tag: Buffer.alloc(15).toString("base64") },
  ];
  for (const invalid of variants) {
    await writeFile(path, JSON.stringify(invalid));
    await assert.rejects(vault.read(), { code: "corrupt" });
  }
  await writeFile(path, Buffer.alloc(65537));
  await assert.rejects(vault.read(), { code: "corrupt" });
});

test("a file with broader permissions is unavailable, not falsely reported as corrupt ciphertext", { skip: !windows }, async (t) => {
  const { parent, vault, path } = await fixture(t);
  await vault.modify(() => [account]);
  const external = join(parent, "broad-permission-fixture.json");
  await writeFile(external, await readFile(path));
  await rename(external, path);
  await assert.rejects(vault.read(), { code: "unavailable" });
});

test("cancellation inside a transaction stays an AbortError and does not commit the change", { skip: !windows }, async (t) => {
  const { vault } = await fixture(t);
  await vault.modify(() => [account]);
  const cancellation = new AbortController();
  await assert.rejects(vault.modify((current) => {
    cancellation.abort();
    return current.map((entry) => ({ ...entry, enabled: false }));
  }, cancellation.signal), { name: "AbortError" });
  assert.deepEqual(await vault.read(), [account]);
});

test("an exception in a transaction releases its operating-system lock", { skip: !windows }, async (t) => {
  const { vault } = await fixture(t);
  await assert.rejects(vault.modify(() => { throw new Error("Synthetic callback failure"); }), { code: "unavailable" });
  await vault.modify(() => [account]);
  assert.deepEqual(await vault.read(), [account]);
});

test("a waiting contender recovers when the lock owner is killed", { skip: !windows, timeout: 15000 }, async (t) => {
  const vaultFixture = await fixture(t);
  await vaultFixture.vault.modify(() => [account]);
  const holder = await holdVault(vaultFixture);
  const reading = new AccountVault(vaultFixture.root).read();
  assert.equal(await staysPending(reading, 500), true);
  await holder.stop();
  assert.deepEqual(await reading, [account]);
  // The same persistent lock file stays in place. No stale-owner deletion,
  // TTL, process-list inspection or manual recovery is involved.
  assert.equal((await lstat(join(vaultFixture.root, "write.lock"))).isFile(), true);
});

test("a held lock times out as unavailable while its owner is still alive", { skip: !windows, timeout: 20000 }, async (t) => {
  const vaultFixture = await fixture(t);
  await vaultFixture.vault.modify(() => [account]);
  const holder = await holdVault(vaultFixture);
  const exited = observeHelperExits(t);
  const started = performance.now();
  await assert.rejects(vaultFixture.vault.read(), { code: "unavailable" });
  const waited = performance.now() - started;
  assert.deepEqual(exited, [true]);
  // Bounded outside FFI by the helper deadline and the host deadline, and long
  // enough to prove the contender waited instead of failing on a busy lock.
  assert.ok(waited > 4000 && waited < 8500, `unexpected wait of ${Math.round(waited)}ms`);
  assert.equal(holder.child.exitCode, null);
  await holder.stop();
  assert.deepEqual(await new AccountVault(vaultFixture.root).read(), [account]);
});

test("cancelling a waiting contender leaves the owner's lock and later reads intact", { skip: !windows, timeout: 15000 }, async (t) => {
  const vaultFixture = await fixture(t);
  await vaultFixture.vault.modify(() => [account]);
  const holder = await holdVault(vaultFixture);
  const exited = observeHelperExits(t);
  const cancellation = new AbortController();
  const reading = vaultFixture.vault.read(cancellation.signal);
  assert.equal(await staysPending(reading, 500), true);
  cancellation.abort();
  await assert.rejects(reading, { name: "AbortError" });
  assert.deepEqual(exited, [true]);
  assert.equal(holder.child.exitCode, null);
  await holder.stop();
  assert.deepEqual(await new AccountVault(vaultFixture.root).read(), [account]);
});

test("protected storage does not load Koffi into the caller", { skip: !windows }, async (t) => {
  const { vault } = await fixture(t);
  await vault.modify(() => [account]);
  assert.deepEqual(await vault.read(), [account]);
  const require = createRequire(import.meta.url);
  assert.equal(Object.keys(require.cache).some((path) => path.replaceAll("\\", "/").endsWith("/koffi.node")), false);
});

test("the helper deadline ends a blocked worker and releases its lock while the host stays alive", { skip: !windows, timeout: 12000 }, async (t) => {
  const { parent, vault, root } = await fixture(t);
  await vault.modify(() => [account]);
  const marker = join(parent, "blocked-worker-marker");
  const restore = faultHelper(t, "block", marker);
  const started = performance.now();
  const blocked = assert.rejects(vault.read(), { code: "unavailable" });
  let observed = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { observed = (await readFile(marker, "utf8")) === "blocked"; } catch {}
    if (observed) break;
    await delay(20);
  }
  assert.equal(observed, true);
  await blocked;
  assert.ok(performance.now() - started < 8000);
  restore();
  assert.deepEqual(await new AccountVault(root).read(), [account]);
});

for (const position of ["before", "after"] as const) {
  test(`a helper failure ${position} rename is indeterminate and never repeats the callback`, { skip: !windows }, async (t) => {
    const { vault, root } = await fixture(t);
    await vault.modify(() => [account]);
    const restore = faultHelper(t, position);
    let callbacks = 0;
    await assert.rejects(vault.modify((current) => {
      callbacks++;
      return current.map((entry) => ({ ...entry, enabled: false }));
    }), { code: "indeterminate", committed: "unknown" });
    assert.equal(callbacks, 1);
    restore();
    const recovered = await new AccountVault(root).read();
    assert.deepEqual(recovered, [{ ...account, enabled: position === "before" }]);
  });
}

test("EOF terminates the helper even while its worker is blocked in a native function", { skip: !windows, timeout: 10000 }, async (t) => {
  const { parent, vault, root } = await fixture(t);
  await vault.modify(() => [account]);
  const marker = join(parent, "eof-native-block-marker");
  const child = spawn(process.execPath, [
    "--import", new URL("./fixtures/storage-fault.mjs", import.meta.url).href,
    fileURLToPath(new URL("../storage/win32-worker.cjs", import.meta.url)),
  ], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "ignore"],
    env: { SystemRoot: process.env.SystemRoot ?? "C:\\Windows", PATH: dirname(process.execPath), GO_STORAGE_TEST_FAULT: "block", GO_STORAGE_TEST_MARKER: marker },
  });
  const closed = once(child, "close");
  t.after(async () => { child.kill(); await closed; });
  child.stdin.write(JSON.stringify({ kind: "read", root }) + "\n");
  let observed = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { observed = (await readFile(marker, "utf8")) === "blocked"; } catch {}
    if (observed) break;
    await delay(20);
  }
  assert.equal(observed, true);
  child.stdin.end();
  const ended = await Promise.race([closed.then(() => true), delay(1200).then(() => false)]);
  if (!ended) { child.kill(); await closed; }
  assert.equal(ended, true);
  assert.deepEqual(await new AccountVault(root).read(), [account]);
});
