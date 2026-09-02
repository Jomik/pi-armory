import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { type ApprovalAction, createApprovalPanel } from "../src/approval-panel.js";

function plainTheme(): Theme {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as Theme;
}

function makePanel(allowEdit: boolean) {
  let action: ApprovalAction | undefined;
  const tui = { requestRender: vi.fn() } as unknown as TUI;
  const panel = createApprovalPanel(
    tui,
    plainTheme(),
    (result) => {
      action = result;
    },
    {
      toolName: "bash",
      command: "echo hi",
      params: {},
      allowEdit,
    },
  );
  return { panel, getAction: () => action };
}

describe("createApprovalPanel", () => {
  it("returns run on Enter", () => {
    const { panel, getAction } = makePanel(false);
    panel.handleInput("\r");
    expect(getAction()).toBe("run");
  });

  it("returns reject on Escape", () => {
    const { panel, getAction } = makePanel(false);
    panel.handleInput("\x1b");
    expect(getAction()).toBe("reject");
  });

  it("returns edit on 'e' when editing is enabled", () => {
    const { panel, getAction } = makePanel(true);
    panel.handleInput("e");
    expect(getAction()).toBe("edit");
  });

  it("ignores 'e' when editing is disabled", () => {
    const { panel, getAction } = makePanel(false);
    panel.handleInput("e");
    expect(getAction()).toBeUndefined();
  });

  it("shows the edit hint only when editing is enabled", () => {
    const { panel: withEdit } = makePanel(true);
    const { panel: withoutEdit } = makePanel(false);
    const renderedWith = withEdit.render(80).join("\n");
    const renderedWithout = withoutEdit.render(80).join("\n");
    expect(renderedWith).toContain("e edit");
    expect(renderedWithout).not.toContain("e edit");
  });

  it("bounds every rendered line to the requested width, even for very narrow widths", () => {
    const { panel } = makePanel(true);
    for (const width of [0, 1, 2, 3, 4, 5, 10]) {
      const lines = panel.render(width);
      for (const line of lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(Math.max(width, 0));
      }
    }
  });
});
