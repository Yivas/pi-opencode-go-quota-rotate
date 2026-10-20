import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, mock } from "node:test";
import type { TestContext } from "node:test";
import { discoverAndLoadExtensions, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CredentialStore, ModelsStoreEntry } from "@earendil-works/pi-ai";
import quotaRotation from "../index.ts";
import { AccountVault } from "../storage/vault.ts";

const credentials: CredentialStore = {
  async read(id) { return id === "opencode-go" ? { type: "api_key", key: "synthetic-test-credential" } : undefined; },
  async list() { return [{ providerId: "opencode-go", type: "api_key" }]; },
  async modify(_id, change) { return change(undefined); },
  async delete() { throw new Error("Unexpected credential mutation"); },
};

async function host(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "go-catalog-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const modelsPath = join(directory, "models.json");
  // The vault follows the host agent directory; keep every test inside its own.
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDirectory = join(directory, "agent");
  await mkdir(agentDirectory);
  process.env.PI_CODING_AGENT_DIR = agentDirectory;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });
  let configuration: Record<string, unknown> = { providers: {} };
  await writeFile(modelsPath, JSON.stringify(configuration));
  let entry: ModelsStoreEntry | undefined;
  let held: Promise<void> | undefined;
  let release = () => {};
  let broken = false;
  let credentialsBroken = false;
  const fixtureCredentials: CredentialStore = {
    ...credentials,
    async read(id, options) {
      if (id === "opencode-go" && credentialsBroken) throw new Error("Synthetic credential failure");
      return credentials.read(id, options);
    },
  };
  const store = {
    async read(id: string) {
      if (id !== "opencode-go") return undefined;
      if (held) await held;
      if (broken) throw new Error("Synthetic catalog read failure");
      return entry ? structuredClone(entry) : undefined;
    },
    async write(id: string, value: ModelsStoreEntry) { if (id === "opencode-go") entry = structuredClone(value); },
    async delete(id: string) { if (id === "opencode-go") entry = undefined; },
  };
  const runtime = await ModelRuntime.create({ credentials: fixtureCredentials, modelsPath, modelsStore: store, refreshOnCreate: false, allowModelNetwork: false });
  const registry = new ModelRegistry(runtime);
  const base = registry.getAll().find((model) => model.provider === "opencode-go" && model.api === "openai-completions");
  assert.ok(base);
  const remote = { ...base, id: "catalog-only-test", name: "Catalog test model" };
  entry = { models: [remote], lastModified: Date.UTC(2099, 0, 1), checkedAt: Date.now() };
  await registry.refresh({ providers: ["opencode-go"], allowNetwork: false });
  const notices: string[] = [];
  const context = { modelRegistry: registry, hasUI: true, ui: { notify(message: string) { notices.push(message); } } } as unknown as ExtensionContext;
  const others = new Map<string, (event: unknown, context: ExtensionContext) => unknown>();
  let commandHandler: ((args: string, context: ExtensionCommandContext) => Promise<void>) | undefined;
  const commands = new Map<string, typeof commandHandler>();
  function start() {
    let handler: ((event: never, context: ExtensionContext) => unknown) | undefined;
    // Pi is the external boundary; the registry/runtime below are real SDK instances.
    quotaRotation({
      on(event: string, callback: never) { if (event === "session_start") handler = callback as typeof handler; else others.set(event, callback); },
      registerCommand(name: string, options: { handler: typeof commandHandler }) { commands.set(name, options.handler); },
    } as unknown as ExtensionAPI);
    assert.ok(handler);
    return Promise.resolve(handler(null as never, context));
  }
  return {
    runtime, registry, notices, start, remote, agentDirectory, context,
    emit(event: string, payload: unknown) { return others.get(event)?.(payload, context); },
    command(name = "go-accounts") { const handler = commands.get(name); assert.ok(handler); return handler; },
    /** Drives the real account panel; each script runs on one opening, later openings close it. */
    async panel(scripts: PanelScript[], ui: Record<string, unknown> = {}, usage: typeof fetch = okUsage) {
      const queue = [...scripts];
      const handler = commands.get("go-accounts");
      assert.ok(handler);
      // The panel reads usage when it opens; serve a synthetic reading instead of the network.
      const previousFetch = globalThis.fetch;
      globalThis.fetch = usage;
      t.after(() => { globalThis.fetch = previousFetch; });
      try { await handler("", { modelRegistry: registry, signal: undefined, ui: {
        notify(message: string) { notices.push(message); },
        async confirm() { return true; },
        custom(factory: (tui: unknown, theme: unknown, keys: unknown, done: (value: unknown) => void) => { handleInput(data: string): void; render(width: number): string[] }) {
          return new Promise((resolve) => {
            const menu = factory({ requestRender() {} }, plainTheme, {}, resolve);
            const send = (...keys: string[]) => { for (const key of keys) menu.handleInput(key); };
            const screen = () => menu.render(160).join(" | ");
            const script = queue.shift();
            if (script) script(send, screen); else send(ESC);
          });
        },
        ...ui,
      } } as unknown as ExtensionCommandContext); } finally { globalThis.fetch = previousFetch; }
    },
    addAccount(label: string, key: string) {
      return this.panel([(send) => send(UP, ENTER, ...label, ENTER, ...key, ENTER)]);
    },
    async configure(custom: boolean) {
      configuration = { providers: { "opencode-go": {
        baseUrl: "https://opencode.ai/zen/go/v1",
        ...(custom ? { models: [{ ...remote, id: "custom-only-test", name: "Custom test model" }] } : {}),
      } } };
      await writeFile(modelsPath, JSON.stringify(configuration));
      await registry.refresh({ providers: ["opencode-go"], allowNetwork: false });
    },
    hold() { held = new Promise<void>((resolve) => { release = resolve; }); },
    release() { held = undefined; release(); },
    breakCatalog(value: boolean) { broken = value; },
    breakCredentials() { credentialsBroken = true; },
  };
}

type PanelScript = (send: (...keys: string[]) => void, screen: () => string) => void;
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";
const okUsage = (async () => new Response(JSON.stringify({ usage: {
  rolling: { status: "ok", percent: 5, resetsAt: "2099-01-01T00:00:00Z" },
  weekly: { status: "ok", percent: 5, resetsAt: "2099-01-01T00:00:00Z" } } }))) as typeof fetch;
const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

function goModels(registry: ModelRegistry) { return registry.getAll().filter((model) => model.provider === "opencode-go"); }

// No test is allowed to make a real HTTP request, even if an auth guard regresses.
const http = mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected external HTTP request"); });

test("Pi's public loader accepts the extension entry", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "go-extension-load-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const loaded = await discoverAndLoadExtensions(
    [fileURLToPath(new URL("../index.ts", import.meta.url))], directory, join(directory, "agent"),
  );
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
});

test("preparation preserves the current catalog until raw publication is accepted", async (t) => {
  const app = await host(t);
  await app.configure(true);
  const before = goModels(app.registry);
  const selectedId = app.remote.id;
  app.hold();
  const starting = app.start();
  assert.deepEqual(goModels(app.registry), before);
  assert.ok(app.registry.find("opencode-go", selectedId));
  app.release();
  await starting;
  assert.deepEqual(goModels(app.registry), before);
  assert.ok(app.registry.find("opencode-go", selectedId));
  assert.deepEqual(app.notices, []);
});

test("configuration changed during preparation is current when its public refresh finishes", async (t) => {
  const app = await host(t);
  await app.configure(true);
  app.hold();
  const starting = app.start();
  const changing = app.configure(false);
  // Synchronous reads during an unfinished refresh may still expose V1. The
  // selected remote model must remain resolvable and no request may be sent.
  assert.ok(app.registry.find("opencode-go", "catalog-only-test"));
  const model = app.registry.find("opencode-go", "catalog-only-test");
  assert.ok(model);
  const blocked = await app.runtime.completeSimple(model, { messages: [] }, { apiKey: "synthetic-explicit-key" });
  assert.equal(blocked.stopReason, "error");
  app.release();
  await Promise.all([starting, changing]);
  assert.equal(app.registry.find("opencode-go", "custom-only-test"), undefined);
  assert.ok(app.registry.find("opencode-go", "catalog-only-test"));
  assert.equal(http.mock.calls.length, 0);
});

test("removing a configured model survives refresh and extension reload without losing the remote catalog", async (t) => {
  const app = await host(t);
  await app.configure(true);
  const unrelated = app.registry.getAll().filter((model) => model.provider !== "opencode-go");
  await app.start();
  assert.ok(app.registry.find("opencode-go", "custom-only-test"));
  await app.configure(false);
  await app.start();
  assert.equal(app.registry.find("opencode-go", "custom-only-test"), undefined);
  assert.ok(app.registry.find("opencode-go", "catalog-only-test"));
  assert.deepEqual(app.registry.getAll().filter((model) => model.provider !== "opencode-go"), unrelated);
});

test("a failed first bootstrap restores original Go and a later start cannot revive removed configuration", async (t) => {
  const app = await host(t);
  await app.configure(true);
  const before = goModels(app.registry);
  app.breakCatalog(true);
  await app.start();
  assert.equal(app.registry.getRegisteredNativeProvider("opencode-go"), undefined);
  assert.deepEqual(goModels(app.registry), before);
  assert.match(app.notices.at(-1) ?? "", /Original Go remains available/);
  app.breakCatalog(false);
  await app.configure(false);
  await app.start();
  assert.equal(app.registry.find("opencode-go", "custom-only-test"), undefined);
  assert.ok(app.registry.find("opencode-go", "catalog-only-test"));
});

test("all three Go APIs reject managed sends, including explicit caller keys, while credentials are not ready", async (t) => {
  const app = await host(t);
  await app.start();
  for (const api of ["anthropic-messages", "openai-completions", "openai-responses"] as const) {
    await app.emit("input", { text: "next" });
    const model = goModels(app.registry).find((entry) => entry.api === api);
    assert.ok(model);
    const result = await app.runtime.completeSimple(model, { messages: [] }, { apiKey: "synthetic-explicit-key" });
    assert.equal(result.stopReason, "error");
    assert.match(result.errorMessage ?? "", /No enabled Go account/);
  }
  assert.equal(http.mock.calls.length, 0);
});

test("credential failure during initial activation never falls back to unmanaged Go", async (t) => {
  const app = await host(t);
  app.breakCredentials();
  await app.start();
  assert.ok(app.registry.getRegisteredNativeProvider("opencode-go"));
  assert.ok(app.registry.find("opencode-go", "catalog-only-test"));
  assert.ok(app.notices.every((notice) => !notice.includes("Original Go remains available")));
});

test("a later catalog failure retains the managed controller and last accepted raw catalog", async (t) => {
  const app = await host(t);
  await app.start();
  const before = goModels(app.registry);
  app.breakCatalog(true);
  await app.start();
  assert.ok(app.registry.getRegisteredNativeProvider("opencode-go"));
  assert.deepEqual(goModels(app.registry), before);
  assert.ok(app.notices.every((notice) => !notice.includes("Original Go remains available")));
});

test("another extension's native provider is not replaced", async (t) => {
  const app = await host(t);
  const other = app.registry.getProvider("opencode-go");
  assert.ok(other);
  app.registry.registerProvider(other);
  await app.start();
  assert.equal(app.registry.getRegisteredNativeProvider("opencode-go"), other);
  assert.match(app.notices.at(-1) ?? "", /Another extension/);
});

const windows = process.platform === "win32" && process.arch === "x64";
const secret = "synthetic-account-key-0001";

test("the account panel adds a key with hidden input and keeps it only in the vault", { skip: !windows }, async (t) => {
  const app = await host(t);
  await app.start();
  let typing = "";
  await app.panel([(send, screen) => {
    send(UP, ENTER, ..."Synthetic one", ENTER, ...secret);
    typing = screen();
    send(ENTER);
  }]);
  assert.equal(typing.includes(secret), false);
  assert.match(typing, new RegExp(`> ${"•".repeat(secret.length)}`));
  const vault = new AccountVault(join(app.agentDirectory, "opencode-go-quota-rotate"));
  const stored = await vault.read();
  assert.equal(stored.length, 1);
  assert.deepEqual({ ...stored[0], id: "" }, { id: "", label: "Synthetic one", apiKey: secret, enabled: true });
  assert.ok(app.notices.includes("Go account added."));
});

test("cancelled, empty or duplicate entries never change the vault", { skip: !windows }, async (t) => {
  const app = await host(t);
  await app.start();
  await app.addAccount("First", secret);
  const vault = new AccountVault(join(app.agentDirectory, "opencode-go-quota-rotate"));
  const before = await vault.read();
  await app.panel([(send) => send(UP, ENTER, ..."Cancelled", ENTER, ..."half-typed", ESC, ESC)]);
  await app.panel([(send) => send(UP, ENTER, ..."Empty", ENTER, ..."   ", ENTER, ESC, ESC)]);
  await app.panel([(send) => send(UP, ENTER, ..."Again", ENTER, ...secret, ENTER)]);
  assert.ok(app.notices.some((notice) => /already stored/.test(notice)));
  assert.deepEqual(await vault.read(), before);
});

test("one panel shows usage per window and lets you disable and remove accounts without exposing keys", { skip: !windows }, async (t) => {
  const app = await host(t);
  await app.start();
  const usage = (async () => new Response(JSON.stringify({ usage: {
    rolling: { status: "ok", percent: 18, resetsAt: "2099-01-01T05:00:00Z" },
    weekly: { status: "ok", percent: 40, resetsAt: "2099-01-07T00:00:00Z" },
    monthly: { status: "ok", percent: 9, resetsAt: "2099-02-01T00:00:00Z" } } }))) as typeof fetch;
  await app.panel([(send) => send(UP, ENTER, ..."Work", ENTER, ...secret, ENTER)], {}, usage);
  const vault = new AccountVault(join(app.agentDirectory, "opencode-go-quota-rotate"));
  const screens: string[] = [];
  await app.panel([
    (send, screen) => { screens.push(screen()); send(ENTER, ENTER); },
    (send, screen) => { screens.push(screen()); send(ENTER, DOWN, ENTER, ENTER); },
    (send, screen) => { screens.push(screen()); send(ESC); },
  ], {}, usage);
  assert.match(screens[0] ?? "", /Work.*5-hour 82% left.*week 60% left.*month 91% left/);
  assert.match(screens[1] ?? "", /Work.*disabled/);
  assert.match(screens[2] ?? "", /No Go accounts are stored/);
  assert.deepEqual(await vault.read(), []);
  assert.equal(JSON.stringify([screens, app.notices]).includes(secret), false);
});

test("Pi's /login for OpenCode Go points to the panel, because its dialog does not hide keys", { skip: !windows }, async (t) => {
  const app = await host(t);
  await app.start();
  await assert.rejects(app.runtime.login("opencode-go", "api_key", { async prompt() { return "x"; }, notify() {} }), /go-accounts/);
});

test("managed requests on all three Go APIs are signed per request with the stored key and never retried by the SDK", { skip: !windows }, async (t) => {
  const app = await host(t);
  await app.start();
  await app.addAccount("Work", secret);
  for (const api of ["anthropic-messages", "openai-completions", "openai-responses"] as const) {
    await app.emit("input", { text: "next" });
    const model = goModels(app.registry).find((entry) => entry.api === api);
    assert.ok(model);
    const seen: { url: string; authorization: string | null; key: string | null; redirect?: string }[] = [];
    const stub = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seen.push({ url: String(input), authorization: headers.get("authorization"), key: headers.get("x-api-key"), redirect: init?.redirect });
      if (String(input).endsWith("/usage")) {
        return new Response(JSON.stringify({ usage: {
          rolling: { status: "ok", percent: 5, resetsAt: "2099-01-01T00:00:00Z" },
          weekly: { status: "ok", percent: 5, resetsAt: "2099-01-01T00:00:00Z" } } }));
      }
      return new Response("unavailable", { status: 500 });
    }) as typeof fetch;
    const result = await app.runtime.completeSimple(model, { messages: [] }, { fetch: stub, maxRetries: 5 });
    assert.equal(result.stopReason, "error");
    const sends = seen.filter((entry) => !entry.url.endsWith("/usage"));
    assert.equal(sends.length, 1, `${api}: a 500 is neither retried nor rotated`);
    for (const send of sends) {
      assert.equal(send.authorization, `Bearer ${secret}`);
      assert.equal(send.key, secret);
      assert.equal(send.redirect, "error");
    }
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
});

test("after a failed managed step the host retry sends nothing, and only new input reopens", { skip: !windows }, async (t) => {
  const app = await host(t);
  await app.start();
  await app.addAccount("Work", secret);
  const model = goModels(app.registry).find((entry) => entry.api === "openai-completions");
  assert.ok(model);
  let sends = 0;
  const stub = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/usage")) {
      return new Response(JSON.stringify({ usage: {
        rolling: { status: "ok", percent: 5, resetsAt: "2099-01-01T00:00:00Z" },
        weekly: { status: "ok", percent: 5, resetsAt: "2099-01-01T00:00:00Z" } } }));
    }
    sends++;
    return new Response("unavailable", { status: 500 });
  }) as typeof fetch;
  const first = await app.runtime.completeSimple(model, { messages: [] }, { fetch: stub });
  assert.equal(first.stopReason, "error");
  assert.equal(sends, 1);
  // The host retries in a new run: no turn event or fresh signal reopens the barrier.
  await app.emit("turn_start", {});
  const retry = await app.runtime.completeSimple(model, { messages: [] }, { fetch: stub });
  assert.equal(retry.stopReason, "error");
  assert.match(retry.errorMessage ?? "", /host retry was not sent/);
  assert.equal(sends, 1);
  await app.emit("input", { text: "again" });
  await app.runtime.completeSimple(model, { messages: [] }, { fetch: stub });
  assert.equal(sends, 2);
});

test("compaction and branch summaries use their own send budget, not the main barrier", { skip: !windows }, async (t) => {
  const app = await host(t);
  await app.start();
  await app.addAccount("Work", secret);
  const model = goModels(app.registry).find((entry) => entry.api === "openai-completions");
  assert.ok(model);
  let sends = 0;
  const stub = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/usage")) {
      return new Response(JSON.stringify({ usage: {
        rolling: { status: "ok", percent: 5, resetsAt: "2099-01-01T00:00:00Z" },
        weekly: { status: "ok", percent: 5, resetsAt: "2099-01-01T00:00:00Z" } } }));
    }
    sends++;
    return new Response("unavailable", { status: 500 });
  }) as typeof fetch;
  await app.runtime.completeSimple(model, { messages: [] }, { fetch: stub }); // closes the main barrier
  const compaction = new AbortController();
  await app.emit("session_before_compact", { signal: compaction.signal });
  for (let step = 0; step < 4; step++) await app.runtime.completeSimple(model, { messages: [] }, { fetch: stub, signal: compaction.signal });
  const fifth = await app.runtime.completeSimple(model, { messages: [] }, { fetch: stub, signal: compaction.signal });
  assert.equal(fifth.stopReason, "error");
  assert.equal(sends, 5, "one main send plus four compaction sends; the fifth never left");
});

test("on platforms without protected storage the extension leaves original Go untouched", async (t) => {
  const app = await host(t);
  const before = goModels(app.registry);
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  assert.ok(descriptor);
  Object.defineProperty(process, "platform", { value: "linux" });
  t.after(() => Object.defineProperty(process, "platform", descriptor));
  await app.start();
  assert.equal(app.registry.getRegisteredNativeProvider("opencode-go"), undefined);
  assert.deepEqual(goModels(app.registry), before);
  assert.match(app.notices.at(-1) ?? "", /only on Windows x64/);
});

test("a failure before the send also closes the barrier, and injected extension input does not reopen it", { skip: !windows }, async (t) => {
  const app = await host(t);
  await app.start();
  const model = goModels(app.registry).find((entry) => entry.api === "openai-completions");
  assert.ok(model);
  let sends = 0;
  const stub = (async () => { sends++; return new Response("x", { status: 500 }); }) as typeof fetch;
  const noAccount = await app.runtime.completeSimple(model, { messages: [] }, { fetch: stub });
  assert.match(noAccount.errorMessage ?? "", /No enabled Go account/);
  await app.addAccount("Work", secret);
  const retry = await app.runtime.completeSimple(model, { messages: [] }, { fetch: stub });
  assert.match(retry.errorMessage ?? "", /host retry was not sent/);
  await app.emit("input", { text: "injected", source: "extension" });
  const still = await app.runtime.completeSimple(model, { messages: [] }, { fetch: stub });
  assert.match(still.errorMessage ?? "", /host retry was not sent/);
  assert.equal(sends, 0);
});

test("the turn retried after a successful overflow compaction is allowed", { skip: !windows }, async (t) => {
  const app = await host(t);
  await app.start();
  await app.addAccount("Work", secret);
  const model = goModels(app.registry).find((entry) => entry.api === "openai-completions");
  assert.ok(model);
  let sends = 0;
  const stub = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/usage")) {
      return new Response(JSON.stringify({ usage: {
        rolling: { status: "ok", percent: 5, resetsAt: "2099-01-01T00:00:00Z" },
        weekly: { status: "ok", percent: 5, resetsAt: "2099-01-01T00:00:00Z" } } }));
    }
    sends++;
    return new Response("overflow", { status: 500 });
  }) as typeof fetch;
  await app.runtime.completeSimple(model, { messages: [] }, { fetch: stub });
  await app.emit("session_before_compact", { signal: new AbortController().signal, willRetry: true });
  await app.emit("session_compact", {});
  await app.runtime.completeSimple(model, { messages: [] }, { fetch: stub });
  assert.equal(sends, 2);
});

test("without the interactive panel the command lists usage as text and never offers adding keys", { skip: !windows }, async (t) => {
  const app = await host(t);
  await app.start();
  await app.addAccount("Work", secret);
  const selects: string[][] = [];
  await app.panel([], {
    async custom() { return undefined; },
    async select(_title: string, options: string[]) { selects.push(options); return selects.length === 1 ? options[0] : "Disable"; },
  });
  assert.ok(app.notices.some((notice) => /Work · 5-hour 95% left/.test(notice)));
  assert.equal(selects.flat().some((option) => /Add/.test(option)), false);
  const vault = new AccountVault(join(app.agentDirectory, "opencode-go-quota-rotate"));
  assert.equal((await vault.read())[0]?.enabled, false);
});
