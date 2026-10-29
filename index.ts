import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isModelType, lazyStream } from "@earendil-works/pi-ai";
import type { AnyModel, Api, ApiStreamOptions, CredentialStore, Model, Provider, RefreshModelsContext, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { join } from "node:path";
import { messages } from "./locales/en.ts";
import { addAccount, removeAccount, toggleAccount } from "./storage/account-setup.ts";
import { AccountVault } from "./storage/vault.ts";
import type { StoredAccount } from "./storage/accounts.ts";
import { gateRevision, StepGate } from "./gate.ts";
import { normalizeFailure } from "./failure.ts";
import type { FailureCause } from "./failure.ts";
import { AccountMenu } from "./menu.ts";
import type { MenuChoice } from "./menu.ts";
import { formatStatus } from "./status.ts";
import type { AccountStatus } from "./transport.ts";
import { ManagedTransport, transportRevision } from "./transport.ts";

// Resolved at use time so tests and reloads follow the host's agent directory.
function accountVault(): AccountVault {
  return new AccountVault(join(getAgentDir(), "opencode-go-quota-rotate"));
}

const providerId = "opencode-go";
const ownership = Symbol.for("pi-opencode-go-quota-rotate.catalog.v1");

interface CatalogState {
  version: 1;
  source: NonNullable<Provider["refreshModels"]>;
  raw?: Provider;
  preparing?: readonly AnyModel[];
  /** Indicative only: set after reading the vault; every request reads it again. */
  ready?: boolean;
  transport?: ManagedTransport;
  gate: StepGate;
}

type OwnedProvider = Provider & { [ownership]?: CatalogState };

// The neutral runtime must never inherit the host's auth file or models.json.
const emptyCredentials: CredentialStore = {
  async read() { return undefined; },
  async list() { return []; },
  async modify() { throw new Error(messages.readOnly); },
  async delete() { throw new Error(messages.readOnly); },
};

async function neutralGo(): Promise<Provider & { refreshModels: NonNullable<Provider["refreshModels"]> }> {
  const runtime = await ModelRuntime.create({
    credentials: emptyCredentials,
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const provider = runtime.getProvider(providerId);
  if (!provider?.refreshModels) throw new Error(messages.catalogFailed);
  return provider as Provider & { refreshModels: NonNullable<Provider["refreshModels"]> };
}

async function refreshCatalog(state: CatalogState, context: RefreshModelsContext): Promise<void> {
  // Keep the host's original source (including its catalog destination), but
  // reconstruct raw metadata separately so models.json cannot become its base.
  await state.source({
    ...context,
    publish: async (publication) => {
      if (context.signal.aborted) return false;
      const candidate = await neutralGo();
      const stored = publication.persist === undefined
        ? context.stored
        : publication.persist ?? undefined;
      await candidate.refreshModels({
        ...context,
        stored,
        allowNetwork: false,
        publish: async (prepared) => {
          if (context.signal.aborted) return false;
          if (prepared.persist !== undefined) throw new Error(messages.catalogFailed);
          prepared.update?.();
          return true;
        },
      });
      if (context.signal.aborted) return false;
      return context.publish({
        ...publication,
        update: () => {
          publication.update?.();
          state.raw = candidate;
          state.preparing = undefined;
        },
      });
    },
  });
}

/** State survives /reload; objects built by an older release are replaced, not reused. */
const transportMethods = ["select", "signedFetch", "status", "confirmExhausted", "reject"] as const;

function transportOf(state: CatalogState): ManagedTransport {
  const current = state.transport as unknown as Record<string, unknown> | undefined;
  // The method check also catches a release that changed methods but forgot the revision bump.
  if (state.transport?.revision !== transportRevision || !transportMethods.every((name) => typeof current?.[name] === "function")) {
    state.transport = newTransport();
  }
  return state.transport;
}

/**
 * Replacing the gate only happens when the release changes. An older gate's
 * closed barrier cannot be read, so the first step after such an update is
 * allowed: the user's own /reload is the input that reopens it.
 */
function gateOfState(state: CatalogState): StepGate {
  const current = state.gate as unknown as Record<string, unknown> | undefined;
  if (state.gate?.revision !== gateRevision || !["authorize", "reopen", "scope"].every((name) => typeof current?.[name] === "function")) {
    state.gate = new StepGate();
  }
  return state.gate;
}

function newTransport(): ManagedTransport {
  return new ManagedTransport({ accounts: (cancel) => accountVault().read(cancel), now: Date.now });
}

function managedStream(state: CatalogState, simple: boolean, model: Model<Api>, context: TranscriptContext, options?: unknown) {
  return lazyStream(model, async () => {
    const raw = state.raw;
    if (!raw) throw new Error(messages.blocked);
    const requested = options as { signal?: AbortSignal; fetch?: typeof fetch } | undefined;
    const signal = requested?.signal ?? new AbortController().signal;
    // Decided before any query or send; a closed barrier costs no network.
    const grant = gateOfState(state).authorize(signal);
    let next: ApiStreamOptions<Api>;
    let transportFailure: FailureCause | undefined;
    try {
      const base = requested?.fetch ?? globalThis.fetch;
      // Authorization happens here, from the protected accounts as they are now.
      const accounts = (await accountVault().read(signal)).filter((entry) => entry.enabled);
      const transport = transportOf(state);
      if (accounts.length === 0) throw new Error(messages.noAccounts);
      const first = await transport.select(accounts, base, signal);
      if (!first) throw new Error(signal.aborted ? messages.storageCancelled : messages.noUsableAccount);
      const signed = transport.signedFetch(accounts, first, base, signal, grant.take, (cause) => { transportFailure = cause; });
      // Retries inside the SDK would bypass the attempt budget; the transport counts every send.
      next = { ...(options as object), apiKey: "managed", fetch: signed, maxRetries: 0 } as ApiStreamOptions<Api>;
    } catch (error) {
      // A failure before the send still ends the step: the host retry must not retry it.
      grant.finish(true, normalizeFailure(error, transportFailure, signal.aborted));
      throw error;
    }
    const result = simple ? raw.streamSimple(model, context, next as SimpleStreamOptions) : raw.stream(model, context, next);
    // The barrier closes before control returns to the host.
    void result.result().then((message) => {
      const failed = message.stopReason === "error" || message.stopReason === "aborted";
      grant.finish(failed, failed ? normalizeFailure(message.errorMessage, transportFailure, message.stopReason === "aborted") : undefined);
    }, (error: unknown) => grant.finish(true, normalizeFailure(error, transportFailure, signal.aborted)));
    return result;
  });
}

function catalogProvider(state: CatalogState): OwnedProvider {
  const allModels = () => state.raw
    ? state.raw.getAllModels?.() ?? state.raw.getModels()
    : state.preparing ?? [];
  const provider: OwnedProvider = {
    id: providerId,
    name: "OpenCode Go",
    auth: {
      apiKey: {
        name: messages.name,
        // Pi's own /login flow supplies the masked prompt. The key goes only to
        // the protected vault; Pi's credential file gets a keyless marker.
        // Pi's login dialog shows typed text; keys are added from /go-accounts instead.
        async login() { throw new Error(messages.loginRedirect); },
        async check() {
          // Indicative only: loaded once after a restart; every request re-reads the vault.
          if (state.ready === undefined) {
            try { state.ready = (await accountVault().read()).some((entry) => entry.enabled); }
            catch { return undefined; }
          }
          return state.ready ? { type: "api_key", source: messages.name } : undefined;
        },
        // Non-secret marker. The real key is chosen per request and never reaches Pi's auth layer.
        async resolve() { return { auth: { apiKey: "managed" }, source: messages.name }; },
      },
    },
    getModels: () => allModels().filter((model) => isModelType(model, "chat")),
    getAllModels: allModels,
    refreshModels: (context) => refreshCatalog(state, context),
    stream: (model, context, options) => managedStream(state, false, model, context, options),
    streamSimple: (model, context, options) => managedStream(state, true, model, context, options),
  };
  Object.defineProperty(provider, ownership, { value: state });
  return provider;
}

function ownedState(provider: Provider | undefined): CatalogState | undefined {
  const state = (provider as OwnedProvider | undefined)?.[ownership];
  return state?.version === 1 && typeof state.source === "function"
    && state.raw?.id === providerId ? state : undefined;
}

async function start(context: ExtensionContext): Promise<void> {
  const registry = context.modelRegistry;
  if (process.platform !== "win32" || process.arch !== "x64") {
    // No protected unattended storage exists elsewhere; never degrade to plaintext.
    context.ui.notify(messages.unsupportedPlatform, "warning");
    return;
  }
  const previous = registry.getRegisteredNativeProvider(providerId);
  const resumed = ownedState(previous);
  if ((previous && !resumed) || registry.getRegisteredProviderConfig(providerId)) {
    context.ui.notify(messages.conflict, "warning");
    return;
  }
  const original = registry.getProvider(providerId);
  if (!original?.refreshModels) {
    context.ui.notify(messages.original, "warning");
    return;
  }
  const state: CatalogState = resumed ?? {
    version: 1,
    gate: new StepGate(),
    source: original.refreshModels.bind(original),
    // This is only a preparation view, never an accepted operational base.
    // Failure removes the registration; success discards the view entirely.
    preparing: structuredClone(original.getAllModels?.() ?? original.getModels()),
  };
  const provider = catalogProvider(state);
  registry.registerProvider(provider);
  try {
    const result = await registry.refresh({ providers: [providerId], allowNetwork: false });
    if (result.aborted || result.errors.has(providerId) || !state.raw) {
      throw new Error(messages.catalogFailed);
    }
  } catch {
    if (!resumed && !state.raw && registry.getRegisteredNativeProvider(providerId) === provider) {
      registry.unregisterProvider(providerId);
      context.ui.notify(messages.original, "warning");
    } else {
      context.ui.notify(messages.catalogFailed, "warning");
    }
  }
}

async function performChoice(state: CatalogState, choice: Exclude<MenuChoice, null>): Promise<string> {
  const vault = accountVault();
  let saved: StoredAccount[];
  if (choice.kind === "add") {
    try { saved = await addAccount(vault, choice.label, choice.key); } finally { choice.key = ""; }
  } else if (choice.kind === "toggle") saved = await toggleAccount(vault, choice.id);
  else saved = await removeAccount(vault, choice.id);
  // Kept in step with every change made here; other processes are covered by the per-request read.
  state.ready = saved.some((entry) => entry.enabled);
  return choice.kind === "add" ? messages.accountAdded : messages.accountChanged;
}

/** Without the interactive terminal there is no hidden input, so adding is not offered. */
async function manageAccountsAsText(context: ExtensionCommandContext, state: CatalogState, status: AccountStatus[]): Promise<void> {
  context.ui.notify(formatStatus(status, Date.now()), "info");
  if (status.length === 0) { context.ui.notify(messages.addOnlyInTerminal, "info"); return; }
  const names = new Map(status.map((entry, index) => [`${index + 1}. ${entry.label} (${entry.enabled ? "on" : "off"})`, entry]));
  const picked = await context.ui.select(messages.menuTitle, [...names.keys()]);
  const account = picked ? names.get(picked) : undefined;
  if (!account) return;
  const actions = new Map<string, "toggle" | "remove">([
    [account.enabled ? messages.accountDisable : messages.accountEnable, "toggle"],
    [messages.accountRemove, "remove"],
  ]);
  const action = actions.get((await context.ui.select(account.label, [...actions.keys()])) ?? "");
  if (!action) return;
  if (action === "remove" && !(await context.ui.confirm(messages.accountRemove, messages.accountRemoveConfirm))) return;
  context.ui.notify(await performChoice(state, { kind: action, id: account.id }), "info");
}

/** The one command: a panel with every account, its usage left and the actions. */
async function manageAccounts(context: ExtensionCommandContext): Promise<void> {
  const state = ownedState(context.modelRegistry.getRegisteredNativeProvider(providerId));
  if (!state) { context.ui.notify(messages.statusInactive, "warning"); return; }
  try {
    for (;;) {
      const accounts = await accountVault().read(context.signal);
      const status = await transportOf(state).status(accounts, globalThis.fetch, context.signal ?? new AbortController().signal);
      const choice = await context.ui.custom<MenuChoice>((tui, theme, _keys, done) =>
        new AccountMenu(() => tui.requestRender(), theme, status, Date.now(), done));
      // RPC and print modes have no custom panels; they resolve undefined.
      if (choice === undefined) { await manageAccountsAsText(context, state, status); return; }
      if (choice === null) return;
      context.ui.notify(await performChoice(state, choice), "info");
    }
  } catch (error) {
    context.ui.notify(error instanceof Error ? error.message : messages.storageFailed, "error");
  }
}

export default function quotaRotation(pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, context) => { await start(context); });
  const gateOf = (context: ExtensionContext) => { const state = ownedState(context.modelRegistry.getRegisteredNativeProvider(providerId)); return state ? gateOfState(state) : undefined; };
  // Only the user's own input reopens; another extension's injected message does not.
  pi.on("input", (event, context) => { if (event.source !== "extension") gateOf(context)?.reopen(); });
  // Overflow recovery: Pi retries the turn after a successful compaction, so that retry is legitimate.
  let retryAfterCompaction = false;
  pi.on("session_before_compact", (event, context) => {
    retryAfterCompaction = event.willRetry;
    gateOf(context)?.scope(event.signal, "compaction");
  });
  pi.on("session_compact", (_event, context) => {
    if (retryAfterCompaction) gateOf(context)?.reopen();
    retryAfterCompaction = false;
  });
  pi.on("session_before_tree", (event, context) => { gateOf(context)?.scope(event.signal, "branch"); });
  pi.registerCommand("go-accounts", { description: messages.accountsMenu, handler: async (_args, context) => manageAccounts(context) });
}
