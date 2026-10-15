import assert from "node:assert/strict";
import { test } from "node:test";
import { parseUsage } from "../quota.ts";
import { choose } from "../selection.ts";
import { ManagedTransport } from "../transport.ts";
import type { StoredAccount } from "../storage/accounts.ts";

const reset = "2099-01-01T00:00:00Z";
const usage = (percent: number, status = "ok") => JSON.stringify({ usage: {
  rolling: { status, percent, resetsAt: reset }, weekly: { status: "ok", percent: 10, resetsAt: reset },
} });
const accounts: StoredAccount[] = ["aaaaaaaa-1", "bbbbbbbb-2"].map((id) => (
  { id, label: id, apiKey: `synthetic-key-${id}`, enabled: true }));

function server(handlers: Record<string, (url: string) => Response>) {
  const calls: { url: string; key: string }[] = [];
  const fetchStub = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const key = new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") ?? "";
    calls.push({ url, key });
    const handler = handlers[key];
    return handler ? handler(url) : new Response("{}", { status: 500 });
  }) as typeof fetch;
  return { calls, fetchStub };
}

test("quota parsing is strict and unknown shapes stay unknown", () => {
  assert.ok(parseUsage(usage(40), 0));
  for (const bad of ["", "[]", "{}", JSON.stringify({ usage: { rolling: { status: "ok", percent: 5 } } }),
    JSON.stringify({ usage: { rolling: { status: "ok", percent: 120, resetsAt: reset }, weekly: { status: "ok", percent: 1 } } }),
    JSON.stringify({ usage: { rolling: { status: "weird", percent: 5 }, weekly: { status: "ok", percent: 1 } } })]) {
    assert.equal(parseUsage(bad, 0), undefined);
  }
});

test("selection keeps the active account, then the most capacity, with stable ties", () => {
  const observed = (id: string, percent: number) => ({ id, excluded: false, observation: parseUsage(usage(percent), 1000) });
  const now = 1500;
  assert.equal(choose([observed("a", 50), observed("b", 5)], "a", now), "a");
  assert.equal(choose([observed("a", 50), observed("b", 5)], undefined, now), "b");
  assert.equal(choose([observed("b", 20), observed("a", 20)], undefined, now), "a");
  assert.equal(choose([{ ...observed("a", 5), excluded: true }, observed("b", 50)], "a", now), "b");
  assert.equal(choose([observed("a", 5)], "a", 1000 + 60_000), "a", "an expired reading leaves the unknown active account usable");
  assert.equal(choose([{ ...observed("a", 5), excluded: true }], "a", 1000 + 60_000), undefined);
});

test("a 429 is rotated once, only after quota confirms exhaustion", async () => {
  let clock = 1_000_000;
  const { calls, fetchStub } = server({
    "synthetic-key-aaaaaaaa-1": (url) => url.endsWith("/usage") ? new Response(usage(100, "rate-limited")) : new Response("limit", { status: 429 }),
    "synthetic-key-bbbbbbbb-2": (url) => url.endsWith("/usage") ? new Response(usage(10)) : new Response("ok", { status: 200 }),
  });
  const transport = new ManagedTransport({ accounts: async () => accounts, now: () => clock });
  const signal = new AbortController().signal;
  const first = await transport.select(accounts, fetchStub, signal);
  const signed = transport.signedFetch(accounts, accounts[0] as StoredAccount, fetchStub, signal);
  clock += 61_000;
  const response = await signed("https://example.test/chat", { method: "POST", body: "{}" });
  assert.ok(first);
  assert.equal(await response.text(), "ok");
  const sends = calls.filter((call) => !call.url.endsWith("/usage"));
  assert.deepEqual(sends.map((call) => call.key), ["synthetic-key-aaaaaaaa-1", "synthetic-key-bbbbbbbb-2"]);
});

test("an unconfirmed 429 returns the original response without rotating", async () => {
  const { calls, fetchStub } = server({
    "synthetic-key-aaaaaaaa-1": (url) => url.endsWith("/usage") ? new Response(usage(30)) : new Response("slow down", { status: 429 }),
    "synthetic-key-bbbbbbbb-2": () => new Response("must not be used", { status: 200 }),
  });
  let clock = 1_000_000;
  const transport = new ManagedTransport({ accounts: async () => accounts, now: () => clock });
  const signal = new AbortController().signal;
  const signed = transport.signedFetch(accounts, accounts[0] as StoredAccount, fetchStub, signal);
  clock += 61_000;
  const response = await signed("https://example.test/chat", { method: "POST" });
  assert.equal(response.status, 429);
  assert.equal(calls.some((call) => call.key.endsWith("bbbbbbbb-2")), false);
});

test("a third send in one request is refused even through SDK retries", async () => {
  const { fetchStub } = server({ "synthetic-key-aaaaaaaa-1": () => new Response("x", { status: 500 }) });
  const transport = new ManagedTransport({ accounts: async () => accounts, now: () => 1 });
  const signed = transport.signedFetch(accounts, accounts[0] as StoredAccount, fetchStub, new AbortController().signal);
  await signed("https://example.test/chat");
  await signed("https://example.test/chat");
  await assert.rejects(signed("https://example.test/chat"), /attempt limit/);
});

test("quota queries never exceed one per account per minute and are shared", async () => {
  const { calls, fetchStub } = server({
    "synthetic-key-aaaaaaaa-1": () => new Response(usage(10)),
    "synthetic-key-bbbbbbbb-2": () => new Response(usage(20)),
  });
  let clock = 5_000_000;
  const transport = new ManagedTransport({ accounts: async () => accounts, now: () => clock });
  const signal = new AbortController().signal;
  await Promise.all([transport.select(accounts, fetchStub, signal), transport.select(accounts, fetchStub, signal)]);
  assert.equal(calls.length, 2);
  clock += 30_000;
  await transport.select(accounts, fetchStub, signal);
  assert.equal(calls.length, 2);
});
