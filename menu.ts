import { Container, Input, SelectList, Spacer, Text } from "@earendil-works/pi-tui";
import type { Component, SelectItem, SelectListTheme } from "@earendil-works/pi-tui";
import { messages } from "./locales/en.ts";
import { describeAccount } from "./status.ts";
import type { AccountStatus } from "./transport.ts";

export type MenuChoice =
  | { kind: "toggle"; id: string }
  | { kind: "remove"; id: string }
  | { kind: "add"; label: string; key: string }
  | null;

export interface MenuTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

const addValue = "\0add";

class Border implements Component {
  readonly #paint: (text: string) => string;
  constructor(paint: (text: string) => string) { this.#paint = paint; }
  render(width: number): string[] { return [this.#paint("─".repeat(Math.max(0, width)))]; }
  invalidate(): void {}
}

/** Shows one bullet per typed character; the value itself is never rendered. */
class MaskedInput implements Component {
  #input = this.#fresh();
  focused = false;
  onSubmit?: (value: string) => void;
  onEscape?: () => void;

  #fresh(): Input {
    const input = new Input();
    input.onSubmit = (value) => this.onSubmit?.(value);
    input.onEscape = () => this.onEscape?.();
    return input;
  }

  handleInput(data: string): void { this.#input.handleInput(data); }
  /** Replaces the editor so its undo history and kill ring do not keep the key. */
  clear(): void { this.#input.setValue(""); this.#input = this.#fresh(); }
  invalidate(): void {}
  render(width: number): string[] {
    const shown = `> ${"•".repeat(this.#input.getValue().length)}${this.focused ? "█" : ""}`;
    return [shown.slice(0, Math.max(0, width))];
  }
}

/**
 * The single account panel: every account with its usage left, an "add" entry,
 * then the actions for the chosen account. It returns one choice; the command
 * performs it and reopens the panel with fresh data.
 */
export class AccountMenu implements Component {
  readonly #root = new Container();
  readonly #theme: MenuTheme;
  readonly #listTheme: SelectListTheme;
  readonly #accounts: AccountStatus[];
  readonly #now: number;
  readonly #done: (choice: MenuChoice) => void;
  readonly #requestRender: () => void;
  #focus: Component & { focused?: boolean } | undefined;
  #secret: MaskedInput | undefined;
  #finished = false;

  constructor(requestRender: () => void, theme: MenuTheme, accounts: AccountStatus[], now: number, done: (choice: MenuChoice) => void) {
    this.#requestRender = requestRender;
    this.#theme = theme;
    this.#accounts = accounts;
    this.#now = now;
    this.#done = done;
    this.#listTheme = {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    };
    this.#showList();
  }

  #finish(choice: MenuChoice): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#done(choice);
  }

  #frame(title: string, body: Component[], hint: string): void {
    this.#root.clear();
    this.#root.addChild(new Border((text) => this.#theme.fg("accent", text)));
    this.#root.addChild(new Text(this.#theme.fg("accent", this.#theme.bold(title)), 1, 0));
    for (const child of body) this.#root.addChild(child);
    this.#root.addChild(new Spacer(1));
    this.#root.addChild(new Text(this.#theme.fg("dim", hint), 1, 0));
    this.#root.addChild(new Border((text) => this.#theme.fg("accent", text)));
    this.#requestRender();
  }

  #focusOn(component: Component & { focused?: boolean }): void {
    if (this.#focus && "focused" in this.#focus) this.#focus.focused = false;
    this.#focus = component;
    if ("focused" in component) component.focused = true;
  }

  #showList(): void {
    const items: SelectItem[] = this.#accounts.map((account) => {
      const { title, detail } = describeAccount(account, this.#now);
      return { value: account.id, label: title, description: detail };
    });
    items.push({ value: addValue, label: messages.menuAdd, description: messages.menuAddDetail });
    const list = new SelectList(items, Math.min(items.length, 10), this.#listTheme, { minPrimaryColumnWidth: 16, maxPrimaryColumnWidth: 28 });
    list.onSelect = (item) => {
      if (item.value === addValue) this.#showLabel();
      else {
        const account = this.#accounts.find((entry) => entry.id === item.value);
        if (account) this.#showActions(account);
      }
    };
    list.onCancel = () => this.#finish(null);
    const body: Component[] = [new Text(this.#theme.fg("dim", messages.menuHint), 1, 0), new Spacer(1)];
    if (this.#accounts.length === 0) body.push(new Text(this.#theme.fg("muted", messages.accountsEmpty), 1, 0));
    body.push(list);
    this.#frame(messages.menuTitle, body, messages.menuKeys);
    this.#focusOn(list);
  }

  #showActions(account: AccountStatus): void {
    const toggle = account.enabled ? messages.accountDisable : messages.accountEnable;
    const list = new SelectList([
      { value: "toggle", label: toggle },
      { value: "remove", label: messages.accountRemove },
      { value: "back", label: messages.menuBack },
    ], 3, this.#listTheme);
    list.onSelect = (item) => {
      if (item.value === "toggle") this.#finish({ kind: "toggle", id: account.id });
      else if (item.value === "remove") this.#showRemove(account);
      else this.#showList();
    };
    list.onCancel = () => this.#showList();
    const { detail } = describeAccount(account, this.#now);
    this.#frame(account.label, [new Text(this.#theme.fg("muted", detail), 1, 0), new Spacer(1), list], messages.menuKeys);
    this.#focusOn(list);
  }

  #showRemove(account: AccountStatus): void {
    const list = new SelectList([
      { value: "remove", label: messages.accountRemove },
      { value: "back", label: messages.menuBack },
    ], 2, this.#listTheme);
    list.onSelect = (item) => {
      if (item.value === "remove") this.#finish({ kind: "remove", id: account.id });
      else this.#showActions(account);
    };
    list.onCancel = () => this.#showActions(account);
    this.#frame(account.label, [new Text(this.#theme.fg("warning", messages.accountRemoveConfirm), 1, 0), new Spacer(1), list], messages.menuKeys);
    this.#focusOn(list);
  }

  #showLabel(): void {
    const input = new Input();
    input.onSubmit = (value) => { if (value.trim()) this.#showKey(value.trim()); };
    input.onEscape = () => this.#showList();
    this.#frame(messages.menuAdd, [new Text(messages.accountLabelPrompt, 1, 0), input], messages.menuInputKeys);
    this.#focusOn(input);
  }

  #showKey(label: string): void {
    const input = new MaskedInput();
    this.#secret = input;
    input.onSubmit = (value) => {
      input.clear();
      if (value.trim()) this.#finish({ kind: "add", label, key: value });
    };
    input.onEscape = () => { input.clear(); this.#showList(); };
    this.#frame(`${messages.menuAdd}: ${label}`, [new Text(messages.accountKeyPrompt, 1, 0), input], messages.menuInputKeys);
    this.#focusOn(input);
  }

  handleInput(data: string): void {
    const target = this.#focus as { handleInput?: (data: string) => void } | undefined;
    target?.handleInput?.(data);
    this.#requestRender();
  }

  /** Pi calls this when the panel closes, whatever the path. */
  dispose(): void { this.#secret?.clear(); this.#secret = undefined; }

  render(width: number): string[] { return this.#root.render(width); }
  invalidate(): void { this.#root.invalidate(); }
}
