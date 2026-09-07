import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { SecretsPanel } from "../src/secrets-panel.js";

vi.mock("../src/keychain.js", () => ({
  listSecrets: vi.fn().mockResolvedValue({ found: ["api-key"], missing: [] }),
  addSecret: vi.fn().mockResolvedValue(undefined),
  removeSecret: vi.fn().mockResolvedValue(undefined),
}));

function plainTheme(): Theme {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as Theme;
}

function makePanel() {
  const tui = { requestRender: vi.fn() } as unknown as TUI;
  const notify = vi.fn();
  const done = vi.fn();
  const panel = new SecretsPanel({
    tui,
    theme: plainTheme(),
    done,
    notify,
    accounts: ["api-key"],
  });
  return { panel, notify, done };
}

function assertLinesFitWidth(lines: string[], width: number) {
  for (const line of lines) {
    expect(visibleWidth(line)).toBeLessThanOrEqual(width);
  }
}

describe("SecretsPanel render at narrow widths", () => {
  it("does not throw and does not return lines wider than the supplied width for very narrow widths", () => {
    const { panel } = makePanel();
    for (const width of [1, 5, 10, 15, 19]) {
      let lines: string[] = [];
      expect(() => {
        lines = panel.render(width);
      }).not.toThrow();
      assertLinesFitWidth(lines, width);
    }
  });

  it("does not return lines wider than the supplied width at normal widths", () => {
    const { panel } = makePanel();
    const lines = panel.render(60);
    assertLinesFitWidth(lines, 60);
  });

  it("still masks typed input in input-value mode at a narrow width", async () => {
    const { panel } = makePanel();
    // Let the initial async secret listing finish so 's' is accepted.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Enter set-secret mode and type a value.
    panel.handleInput("s");
    panel.handleInput("hello");

    const lines = panel.render(15);
    assertLinesFitWidth(lines, 15);
    const rendered = lines.join("\n");
    expect(rendered).not.toContain("hello");
    expect(rendered).toContain("\u2022");
  });
});
