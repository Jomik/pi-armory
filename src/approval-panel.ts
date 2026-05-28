import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { formatParamValue } from "./shared.js";

export interface ApprovalPanelOptions {
  toolName: string;
  command: string;
  params: Record<string, unknown>;
}

export function createApprovalPanel(
  tui: TUI,
  theme: Theme,
  done: (approved: boolean) => void,
  options: ApprovalPanelOptions,
): { render(width: number): string[]; handleInput(data: string): void; invalidate(): void } {
  let scrollOffset = 0;
  let maxScroll = 0;
  const VIEWPORT_LINES = 20;

  function buildContent(innerWidth: number): string[] {
    const lines: string[] = [];
    const LABEL = 14;
    const fieldWidth = Math.max(innerWidth - LABEL - 2, 8);

    lines.push(` ${theme.fg("accent", theme.bold(`Approve: ${options.toolName}`))}`);
    lines.push("");

    // Command (template, not interpolated)
    const cmdLabel = "Command:".padEnd(LABEL);
    const wrappedCmd = wrapTextWithAnsi(theme.fg("text", options.command), fieldWidth);
    for (let i = 0; i < wrappedCmd.length; i++) {
      lines.push(` ${i === 0 ? theme.fg("muted", cmdLabel) : " ".repeat(LABEL)} ${wrappedCmd[i] ?? ""}`);
    }

    lines.push("");

    // Parameters
    const paramEntries = Object.entries(options.params);
    if (paramEntries.length > 0) {
      const paramsLabel = "Parameters:".padEnd(LABEL);
      lines.push(` ${theme.fg("muted", paramsLabel)}`);
      for (const [key, value] of paramEntries) {
        const displayValue = formatParamValue(value);
        const paramLabel = `  ${key}:`.padEnd(LABEL);
        const wrapped = wrapTextWithAnsi(theme.fg("text", displayValue), fieldWidth);
        for (let i = 0; i < wrapped.length; i++) {
          lines.push(` ${i === 0 ? theme.fg("muted", paramLabel) : " ".repeat(LABEL)} ${wrapped[i] ?? ""}`);
        }
      }
      lines.push("");
    }

    lines.push(` ${theme.fg("dim", "Enter approve  •  Esc reject  •  ↑↓ scroll")}`);

    return lines;
  }

  return {
    invalidate() {},

    render(width: number): string[] {
      const innerWidth = width - 4; // │ + space on each side
      const content = buildContent(innerWidth);
      const visibleCount = Math.min(content.length, VIEWPORT_LINES);
      maxScroll = Math.max(0, content.length - visibleCount);

      // Clamp scroll
      if (scrollOffset > maxScroll) {
        scrollOffset = maxScroll;
      }

      const side = theme.fg("accent", "│");
      const lines: string[] = [];

      // Top border
      lines.push(theme.fg("accent", `╭${"─".repeat(width - 2)}╮`));

      // Content lines with side borders (fixed viewport size)
      for (let i = 0; i < visibleCount; i++) {
        const line = content[scrollOffset + i] ?? "";
        const padded = truncateToWidth(line, innerWidth);
        const pad = Math.max(0, innerWidth - visibleWidth(padded));
        lines.push(`${side} ${padded}${" ".repeat(pad)} ${side}`);
      }

      // Bottom border
      lines.push(theme.fg("accent", `╰${"─".repeat(width - 2)}╯`));

      return lines;
    },

    handleInput(data: string): void {
      if (matchesKey(data, Key.enter)) {
        done(true);
      } else if (matchesKey(data, Key.escape)) {
        done(false);
      } else if (matchesKey(data, Key.down) || matchesKey(data, Key.ctrl("n"))) {
        if (scrollOffset < maxScroll) {
          scrollOffset++;
          tui.requestRender();
        }
      } else if (matchesKey(data, Key.up) || matchesKey(data, Key.ctrl("p"))) {
        if (scrollOffset > 0) {
          scrollOffset--;
          tui.requestRender();
        }
      }
    },
  };
}
