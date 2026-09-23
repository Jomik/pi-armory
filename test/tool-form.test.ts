import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { EnvSets } from "../src/config.js";
import { type ToolFormResult, type ToolFormState, toolFormPanel } from "../src/tool-form.js";

function plainTheme(): Theme {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as Theme;
}

function makePanel(
  guidelines: string[] = [],
  callbacks?: Parameters<typeof toolFormPanel>[4],
  when?: "git" | "jj",
  initial?: Partial<ToolFormState>,
) {
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
      ...(when ? { when } : {}),
      ...initial,
    },
    callbacks,
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

  it("does not remove guidelines when backspacing on an already-empty add-new row", () => {
    const { panel, getResult } = makePanel(["first", "second"]);
    focusGuidelines(panel);

    backspace(panel, 1); // add-new row already empty
    approveFromGuidelines(panel);

    expect(getResult()?.guidelines).toEqual(["first", "second"]);
  });
});

function focusRedraft(panel: ReturnType<typeof makePanel>["panel"]) {
  for (let i = 0; i < 8; i++) panel.handleInput("\t"); // name -> ... -> env sets -> re-draft
}

describe("toolFormPanel re-draft", () => {
  it("applies fields returned by a successful re-draft", async () => {
    const onRedraft = vi.fn().mockResolvedValue({ command: "npm test --silent", requiresApproval: true });
    const { panel, getResult } = makePanel([], { onRedraft });
    focusRedraft(panel);

    panel.handleInput("\r"); // enter instruction mode
    panel.handleInput("be faster");
    panel.handleInput("\r"); // submit instruction, triggers onRedraft
    await new Promise((resolve) => setTimeout(resolve, 0));

    panel.handleInput("\x1b[A"); // move focus off re-draft to destination
    panel.handleInput("\r"); // approve

    expect(onRedraft).toHaveBeenCalledWith(expect.objectContaining({ name: "run_tests" }), "be faster");
    expect(getResult()?.command).toBe("npm test --silent");
    expect(getResult()?.requiresApproval).toBe(true);
  });

  it("shows an error and leaves fields unchanged when re-draft fails", async () => {
    const onRedraft = vi.fn().mockRejectedValue(new Error("boom"));
    const { panel, getResult } = makePanel([], { onRedraft });
    focusRedraft(panel);

    panel.handleInput("\r"); // enter instruction mode
    panel.handleInput("be faster");
    panel.handleInput("\r"); // submit instruction, triggers onRedraft
    await new Promise((resolve) => setTimeout(resolve, 0));

    const rendered = panel.render(100).join("\n");
    expect(rendered).toContain("Re-draft failed");

    panel.handleInput("\x1b[A"); // move focus off re-draft to destination
    panel.handleInput("\r"); // approve, state should be untouched

    expect(getResult()?.command).toBe("npm test");
    expect(getResult()?.name).toBe("run_tests");
  });

  it("leaves fields unchanged when re-draft resolves with no result (unavailable)", async () => {
    const onRedraft = vi.fn().mockResolvedValue(null);
    const { panel, getResult } = makePanel([], { onRedraft });
    focusRedraft(panel);

    panel.handleInput("\r"); // enter instruction mode
    panel.handleInput("be faster");
    panel.handleInput("\r"); // submit instruction, triggers onRedraft
    await new Promise((resolve) => setTimeout(resolve, 0));

    const rendered = panel.render(100).join("\n");
    expect(rendered).toContain("Re-draft unavailable");

    panel.handleInput("\x1b[A"); // move focus off re-draft to destination
    panel.handleInput("\r"); // approve, state should be untouched

    expect(onRedraft).toHaveBeenCalledOnce();
    expect(getResult()?.command).toBe("npm test");
  });
});

describe("toolFormPanel env set selection", () => {
  const project: EnvSets = {
    alpha: { TOKEN: { env: "HOST_TOKEN", secret: true } },
    beta: { COLOR: "blue" },
  };

  function focusEnv(panel: ReturnType<typeof makePanel>["panel"]) {
    for (let i = 0; i < 7; i++) panel.handleInput("\t");
  }

  it("selects multiple sets by name and returns an explicit empty array when cleared", () => {
    const { panel, getResult } = makePanel([], undefined, undefined, { destination: "project", envSets: { project } });
    focusEnv(panel);
    panel.handleInput(" "); // alpha
    panel.handleInput("\x1b[C"); // beta
    panel.handleInput(" ");
    expect(panel.render(100).join("\n")).toContain("☑ beta");
    panel.handleInput("\r");
    expect(getResult()?.envFrom).toEqual(["alpha", "beta"]);

    const cleared = makePanel([], undefined, undefined, {
      destination: "project",
      envSets: { project },
      envFrom: ["alpha"],
    });
    focusEnv(cleared.panel);
    cleared.panel.handleInput(" ");
    cleared.panel.handleInput("\r");
    expect(cleared.getResult()?.envFrom).toEqual([]);
  });

  it("rejects selected sets in session but permits deselection and approval", () => {
    const { panel, getResult } = makePanel([], undefined, undefined, {
      destination: "project",
      envSets: { project },
      envFrom: ["alpha"],
    });
    for (let i = 0; i < 5; i++) panel.handleInput("\t");
    panel.handleInput("\x1b[D"); // project -> session
    panel.handleInput("\r");
    expect(getResult()).toBeUndefined();
    expect(panel.render(100).join("\n")).toContain("alpha (unresolved)");
    panel.handleInput("\t"); // condition
    panel.handleInput("\t"); // env sets
    panel.handleInput(" "); // deselect alpha
    panel.handleInput("\r");
    expect(getResult()?.envFrom).toEqual([]);
    expect(getResult()?.destination).toBe("session");
  });

  it("requires explicit deselect and reselect when same-name definitions differ, ignoring key order", () => {
    const global: EnvSets = {
      alpha: { TOKEN: { secret: true, env: "HOST_TOKEN" } },
    };
    const { panel, getResult } = makePanel([], undefined, undefined, {
      destination: "project",
      envSets: { project, global },
      envFrom: ["alpha"],
    });
    for (let i = 0; i < 5; i++) panel.handleInput("\t");
    panel.handleInput("\x1b[C"); // global, equivalent definition
    panel.handleInput("\r");
    expect(getResult()?.envFrom).toEqual(["alpha"]);

    const different: EnvSets = { alpha: { TOKEN: { env: "HOST_TOKEN", secret: false } } };
    const changed = makePanel([], undefined, undefined, {
      destination: "project",
      envSets: { project, global: different },
      envFrom: ["alpha"],
    });
    for (let i = 0; i < 5; i++) changed.panel.handleInput("\t");
    changed.panel.handleInput("\x1b[C");
    changed.panel.handleInput("\r");
    expect(changed.getResult()).toBeUndefined();
    expect(changed.panel.render(100).join("\n")).toContain("alpha (unresolved)");
    changed.panel.handleInput("\t");
    changed.panel.handleInput("\t");
    changed.panel.handleInput(" "); // remove old source
    changed.panel.handleInput(" "); // select target definition
    changed.panel.handleInput("\r");
    expect(changed.getResult()?.envFrom).toEqual(["alpha"]);
  });

  it("keeps human selections across re-draft and never exposes definitions to the callback or UI", async () => {
    const onRedraft = vi.fn().mockResolvedValue({ destination: "global", envFrom: [] });
    const { panel, getResult } = makePanel([], { onRedraft }, undefined, {
      destination: "project",
      envSets: { project, global: { alpha: { TOKEN: { command: "private-resolver", secret: true } } } },
      envFrom: ["alpha"],
    });
    focusRedraft(panel);
    panel.handleInput("\r");
    panel.handleInput("change destination");
    panel.handleInput("\r");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onRedraft.mock.calls[0]?.[0].envFrom).toEqual(["alpha"]);
    expect(onRedraft.mock.calls[0]?.[0]).not.toHaveProperty("envSets");
    const rendered = panel.render(100).join("\n");
    expect(rendered).toContain("alpha (unresolved)");
    expect(rendered).not.toContain("private-resolver");
    expect(rendered).not.toContain("HOST_TOKEN");
    panel.handleInput("\x1b[A"); // env sets
    panel.handleInput("\r");
    expect(getResult()).toBeUndefined();
    panel.handleInput(" ");
    panel.handleInput(" ");
    panel.handleInput("\r");
    expect(getResult()?.envFrom).toEqual(["alpha"]);
    expect(getResult()?.destination).toBe("global");
  });
});

describe("toolFormPanel condition", () => {
  it("returns the initial when unchanged when approved without touching the condition field", () => {
    const { panel, getResult } = makePanel([], undefined, "jj");

    for (let i = 0; i < 4; i++) panel.handleInput("\t"); // name -> ... -> approval
    panel.handleInput("\r"); // approve

    expect(getResult()?.when).toBe("jj");
  });

  it("Condition control cycles Always -> Git -> Jj -> Always", () => {
    const { panel, getResult } = makePanel();

    for (let i = 0; i < 6; i++) panel.handleInput("\t"); // name -> ... -> condition
    panel.handleInput("\x1b[C"); // Always -> Git
    let rendered = panel.render(100).join("\n");
    expect(rendered).toMatch(/● Git/);

    panel.handleInput("\x1b[C"); // Git -> Jj
    rendered = panel.render(100).join("\n");
    expect(rendered).toMatch(/● Jj/);

    panel.handleInput("\x1b[C"); // Jj -> Always
    panel.handleInput("\r"); // approve

    expect(getResult()?.when).toBeUndefined();
  });

  it("redraft can set a when value", async () => {
    const onRedraft = vi.fn().mockResolvedValue({ when: "git" });
    const { panel, getResult } = makePanel([], { onRedraft });
    focusRedraft(panel);

    panel.handleInput("\r"); // enter instruction mode
    panel.handleInput("restrict to git repos");
    panel.handleInput("\r"); // submit instruction, triggers onRedraft
    await new Promise((resolve) => setTimeout(resolve, 0));

    panel.handleInput("\x1b[A"); // move focus off re-draft
    panel.handleInput("\r"); // approve

    expect(getResult()?.when).toBe("git");
  });

  it("redraft can clear an existing when value", async () => {
    const onRedraft = vi.fn().mockResolvedValue({ when: undefined });
    const { panel, getResult } = makePanel([], { onRedraft }, "git");
    focusRedraft(panel);

    panel.handleInput("\r"); // enter instruction mode
    panel.handleInput("no longer git-specific");
    panel.handleInput("\r"); // submit instruction, triggers onRedraft
    await new Promise((resolve) => setTimeout(resolve, 0));

    panel.handleInput("\x1b[A"); // move focus off re-draft
    panel.handleInput("\r"); // approve

    expect(getResult()?.when).toBeUndefined();
  });
});
