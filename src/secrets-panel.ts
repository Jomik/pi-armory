import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey } from "@earendil-works/pi-tui";
import { addSecret, listSecrets, removeSecret } from "./keychain.js";

type Mode = "list" | "confirm-delete" | "input-value";

export interface SecretsPanelOptions {
  tui: TUI;
  theme: Theme;
  done: (result: null) => void;
  notify: (message: string, type: "info") => void;
  accounts: string[];
}

export class SecretsPanel implements Component {
  private mode: Mode = "list";
  private cursor = 0;
  private accounts: string[] = [];
  private found = new Set<string>();
  private loading = true;
  private inputBuffer = "";
  private targetName = "";

  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly done: SecretsPanelOptions["done"];
  private readonly notify: SecretsPanelOptions["notify"];

  constructor(options: SecretsPanelOptions) {
    this.tui = options.tui;
    this.theme = options.theme;
    this.done = options.done;
    this.notify = options.notify;
    this.accounts = options.accounts;

    this.refresh();
  }

  private refresh(): void {
    this.loading = true;
    void listSecrets(this.accounts).then(({ found }) => {
      this.found = new Set(found);
      this.loading = false;
      this.tui.requestRender();
    });
  }

  dispose(): void {}

  invalidate(): void {}

  render(width: number): string[] {
    const w = Math.max(width - 2, 20);
    const { theme } = this;
    const border = theme.fg("muted", "│");
    const lines: string[] = [];

    // Title bar: ╭─ Armory Secrets ──...╮
    const titleLabel = " Armory Secrets ";
    const remaining = Math.max(0, w - 1 - titleLabel.length);
    lines.push(
      `${theme.fg("muted", "╭─")}${theme.fg("accent", titleLabel)}${theme.fg("muted", `─${"─".repeat(remaining)}╮`)}`,
    );

    lines.push(`${border}${" ".repeat(w)}${border}`);

    switch (this.mode) {
      case "list":
        this.renderList(lines, w, border);
        break;
      case "confirm-delete":
        this.renderConfirmDelete(lines, w, border);
        break;
      case "input-value":
        this.renderInputValue(lines, w, border);
        break;
    }

    lines.push(`${border}${" ".repeat(w)}${border}`);
    lines.push(`${border}${this.pad(` ${this.renderHints()}`, w)}${border}`);
    lines.push(theme.fg("muted", `╰${"─".repeat(w)}╯`));

    return lines;
  }

  private renderList(lines: string[], w: number, border: string): void {
    const { theme } = this;
    if (this.loading) {
      lines.push(`${border}${this.pad(`  ${theme.fg("muted", "Loading...")}`, w)}${border}`);
    } else if (this.accounts.length === 0) {
      lines.push(`${border}${this.pad(`  ${theme.fg("muted", "(no secrets configured)")}`, w)}${border}`);
    } else {
      for (let i = 0; i < this.accounts.length; i++) {
        const name = this.accounts[i] ?? "";
        const status = this.found.has(name) ? theme.fg("success", "✓") : theme.fg("error", "✗");
        const prefix = i === this.cursor ? theme.fg("accent", "❯") : " ";
        const text = i === this.cursor ? theme.fg("accent", name) : name;
        lines.push(`${border}${this.pad(`  ${prefix} ${status} ${text}`, w)}${border}`);
      }
    }
  }

  private renderConfirmDelete(lines: string[], w: number, border: string): void {
    const { theme } = this;
    lines.push(`${border}${this.pad(`  ${theme.fg("accent", `Delete '${this.targetName}'?`)}`, w)}${border}`);
  }

  private renderInputValue(lines: string[], w: number, border: string): void {
    const { theme } = this;
    const maxDots = Math.max(0, w - 4);
    const masked =
      this.inputBuffer.length > 0
        ? "•".repeat(Math.min(this.inputBuffer.length, maxDots))
        : theme.fg("muted", "(type secret value)");
    lines.push(`${border}${this.pad(`  ${theme.fg("accent", `Value for '${this.targetName}':`)}`, w)}${border}`);
    lines.push(`${border}${this.pad(`  ${masked}`, w)}${border}`);
  }

  private renderHints(): string {
    const { theme } = this;
    switch (this.mode) {
      case "list":
        return theme.fg("dim", "s set  d delete  Esc close");
      case "confirm-delete":
        return theme.fg("dim", "y confirm  n/Esc cancel");
      case "input-value":
        return theme.fg("dim", "Enter confirm  Esc cancel");
    }
  }

  handleInput(data: string): void {
    switch (this.mode) {
      case "list":
        this.handleListInput(data);
        break;
      case "confirm-delete":
        this.handleConfirmDeleteInput(data);
        break;
      case "input-value":
        this.handleTextInput(data, () => {
          const value = this.inputBuffer.trim();
          if (value) {
            const name = this.targetName;
            void addSecret(name, value)
              .then(() => {
                this.inputBuffer = "";
                this.mode = "list";
                this.notify(`Secret '${name}' saved.`, "info");
                this.refresh();
              })
              .catch(() => {
                this.mode = "list";
                this.inputBuffer = "";
                this.notify(`Failed to save secret '${name}'.`, "info");
                this.tui.requestRender();
              });
          }
        });
        break;
    }
  }

  private handleListInput(data: string): void {
    if (this.loading) return;

    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      this.done(null);
      return;
    }
    if (matchesKey(data, "up") || matchesKey(data, "k")) {
      if (this.accounts.length > 0) {
        this.cursor = (this.cursor - 1 + this.accounts.length) % this.accounts.length;
        this.tui.requestRender();
      }
      return;
    }
    if (matchesKey(data, "down") || matchesKey(data, "j")) {
      if (this.accounts.length > 0) {
        this.cursor = (this.cursor + 1) % this.accounts.length;
        this.tui.requestRender();
      }
      return;
    }
    if (matchesKey(data, "d") && this.accounts.length > 0) {
      this.targetName = this.accounts[this.cursor] ?? "";
      this.mode = "confirm-delete";
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "s") && this.accounts.length > 0) {
      this.targetName = this.accounts[this.cursor] ?? "";
      this.inputBuffer = "";
      this.mode = "input-value";
      this.tui.requestRender();
      return;
    }
  }

  private handleConfirmDeleteInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "n")) {
      this.mode = "list";
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "y")) {
      const name = this.targetName;
      void removeSecret(name)
        .then(() => {
          this.cursor = Math.min(this.cursor, Math.max(0, this.accounts.length - 1));
          this.mode = "list";
          this.notify(`Secret '${name}' deleted.`, "info");
          this.refresh();
        })
        .catch(() => {
          this.mode = "list";
          this.notify(`Failed to delete secret '${name}'.`, "info");
          this.tui.requestRender();
        });
    }
  }

  /** Shared text-input handler for input-value mode. */
  private handleTextInput(data: string, onEnter: () => void): void {
    if (matchesKey(data, "escape")) {
      this.mode = "list";
      this.inputBuffer = "";
      this.tui.requestRender();
      return;
    }
    if (matchesKey(data, "enter")) {
      onEnter();
      return;
    }
    if (matchesKey(data, "backspace")) {
      this.inputBuffer = this.inputBuffer.slice(0, -1);
      this.tui.requestRender();
      return;
    }
    // Ctrl+U — clear line
    if (data === "\x15") {
      this.inputBuffer = "";
      this.tui.requestRender();
      return;
    }
    // Accept printable characters (handles paste — multi-char input)
    let changed = false;
    for (const ch of data) {
      if (ch.charCodeAt(0) >= 32) {
        this.inputBuffer += ch;
        changed = true;
      }
    }
    if (changed) {
      this.tui.requestRender();
    }
  }

  private visibleLength(text: string): number {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequence matching
    return text.replace(/\u001b\[[0-9;]*m/g, "").length;
  }

  private pad(text: string, width: number): string {
    const visible = this.visibleLength(text);
    return text + " ".repeat(Math.max(0, width - visible));
  }
}
