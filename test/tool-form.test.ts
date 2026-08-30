import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { type ToolFormResult, toolFormPanel } from "../src/tool-form.js";

function plainTheme(): Theme {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as Theme;
}

function makePanel(guidelines: string[] = []) {
  let result: ToolFormResult | undefined;
  const tui = { requestRender: vi.fn() } as unknown as TUI;
  const panel = toolFormPanel(
    tui,
    plainTheme(),
    (value) => {
      if (!("rejected" in value)) result = value;
    },
    {
      title: "Request Tool",
      name: "run_tests",
      command: "npm test",
      description: "Run tests",
      guidelines,
      requiresApproval: false,
      destination: "session",
    },
  );

  return { panel, getResult: () => result };
}

function focusGuidelines(panel: ReturnType<typeof makePanel>["panel"]) {
  panel.handleInput("\r"); // name -> command
  panel.handleInput("\r"); // command -> description
  panel.handleInput("\r"); // description -> guidelines
}

function approveFromGuidelines(panel: ReturnType<typeof makePanel>["panel"]) {
  panel.handleInput("\t"); // guidelines -> approval
  panel.handleInput("\r"); // approve
}

function backspace(panel: ReturnType<typeof makePanel>["panel"], count: number) {
  for (let i = 0; i < count; i++) panel.handleInput("\x7f");
}

describe("toolFormPanel guideline editing", () => {
  it("edits a prior guideline without removing later guidelines", () => {
    const { panel, getResult } = makePanel(["first", "second"]);
    focusGuidelines(panel);

    panel.handleInput("\x1b[A"); // add row -> second
    panel.handleInput("\x1b[A"); // second -> first
    backspace(panel, "first".length);
    panel.handleInput("first updated");
    panel.handleInput("\r");
    approveFromGuidelines(panel);

    expect(getResult()?.guidelines).toEqual(["first updated", "second"]);
  });

  it("deletes the selected middle guideline instead of the last guideline", () => {
    const { panel, getResult } = makePanel(["first", "second", "third"]);
    focusGuidelines(panel);

    panel.handleInput("\x1b[A"); // add row -> third
    panel.handleInput("\x1b[A"); // third -> second
    panel.handleInput("\x1b[3~"); // delete selected guideline
    approveFromGuidelines(panel);

    expect(getResult()?.guidelines).toEqual(["first", "third"]);
  });

  it("moves up from a pending new guideline to the previous existing guideline", () => {
    const { panel, getResult } = makePanel(["first", "second"]);
    focusGuidelines(panel);

    panel.handleInput("third");
    panel.handleInput("\x1b[A"); // commit third, then select second
    backspace(panel, "second".length);
    panel.handleInput("second updated");
    panel.handleInput("\r");
    approveFromGuidelines(panel);

    expect(getResult()?.guidelines).toEqual(["first", "second updated", "third"]);
  });

  it("moves down from a cleared guideline to the item that shifts into its place", () => {
    const { panel, getResult } = makePanel(["first", "second", "third"]);
    focusGuidelines(panel);

    panel.handleInput("\x1b[A"); // add row -> third
    panel.handleInput("\x1b[A"); // third -> second
    backspace(panel, "second".length);
    panel.handleInput("\x1b[B"); // delete second, then select third
    panel.handleInput(" updated");
    panel.handleInput("\r");
    approveFromGuidelines(panel);

    expect(getResult()?.guidelines).toEqual(["first", "third updated"]);
  });

  it("still appends new guidelines", () => {
    const { panel, getResult } = makePanel();
    focusGuidelines(panel);

    panel.handleInput("first");
    panel.handleInput("\r");
    panel.handleInput("second");
    panel.handleInput("\r");
    approveFromGuidelines(panel);

    expect(getResult()?.guidelines).toEqual(["first", "second"]);
  });
});
