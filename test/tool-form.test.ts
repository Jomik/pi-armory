import { describe, expect, it, vi } from "vitest";
import { type ToolFormResult, type ToolFormUI, toolFormPanel } from "../src/tool-form.js";

function makeUi(overrides: Partial<ToolFormUI> = {}): ToolFormUI {
  return {
    select: vi.fn().mockResolvedValue(undefined),
    input: vi.fn().mockResolvedValue(undefined),
    editor: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn(),
    ...overrides,
  };
}

function queue<T>(...values: T[]) {
  let i = 0;
  return vi.fn(async () => (i < values.length ? values[i++] : undefined));
}

const baseState = {
  title: "Request Tool",
  name: "run_tests",
  command: "npm test",
  description: "Run tests",
  guidelines: [] as string[],
  requiresApproval: false,
  destination: "session" as const,
};

describe("toolFormPanel guideline editing", () => {
  it("edits one guideline without changing later entries", async () => {
    const select = queue("Edit guideline 1", "Save");
    const input = queue("first updated");
    const ui = makeUi({ select, input });

    const result = await toolFormPanel(ui, { ...baseState, guidelines: ["first", "second"] });

    expect((result as ToolFormResult).guidelines).toEqual(["first updated", "second"]);
    expect(input).toHaveBeenCalledWith("Guideline 1", "first");
  });

  it("deletes a middle guideline", async () => {
    const select = queue("Remove guideline 2", "Save");
    const ui = makeUi({ select });

    const result = await toolFormPanel(ui, { ...baseState, guidelines: ["first", "second", "third"] });

    expect((result as ToolFormResult).guidelines).toEqual(["first", "third"]);
  });

  it("adds guidelines", async () => {
    const select = queue("Add guideline", "Add guideline", "Save");
    const input = queue("first", "second");
    const ui = makeUi({ select, input });

    const result = await toolFormPanel(ui, { ...baseState, guidelines: [] });

    expect((result as ToolFormResult).guidelines).toEqual(["first", "second"]);
  });

  it("does not add a guideline when input is cancelled or empty", async () => {
    const select = queue("Add guideline", "Add guideline", "Save");
    const input = queue(undefined, "   ");
    const ui = makeUi({ select, input });

    const result = await toolFormPanel(ui, { ...baseState, guidelines: [] });

    expect((result as ToolFormResult).guidelines).toEqual([]);
  });

  it("trims whitespace when adding a guideline", async () => {
    const select = queue("Add guideline", "Save");
    const input = queue("  spaced out  ");
    const ui = makeUi({ select, input });

    const result = await toolFormPanel(ui, { ...baseState, guidelines: [] });

    expect((result as ToolFormResult).guidelines).toEqual(["spaced out"]);
  });

  it("trims whitespace when editing a guideline", async () => {
    const select = queue("Edit guideline 1", "Save");
    const input = queue("  updated  ");
    const ui = makeUi({ select, input });

    const result = await toolFormPanel(ui, { ...baseState, guidelines: ["first"] });

    expect((result as ToolFormResult).guidelines).toEqual(["updated"]);
  });

  it("deletes a guideline when edited to blank/whitespace", async () => {
    const select = queue("Edit guideline 1", "Save");
    const input = queue("   ");
    const ui = makeUi({ select, input });

    const result = await toolFormPanel(ui, { ...baseState, guidelines: ["first", "second"] });

    expect((result as ToolFormResult).guidelines).toEqual(["second"]);
  });
});

describe("toolFormPanel field editing", () => {
  it("saves current values when dialogs are cancelled", async () => {
    const select = queue("Edit name", "Save");
    const input = queue(undefined); // cancel
    const ui = makeUi({ select, input });

    const result = await toolFormPanel(ui, baseState);

    expect((result as ToolFormResult).name).toBe("run_tests");
  });

  it("allows explicit empty values", async () => {
    const select = queue("Edit description", "Save");
    const editor = queue("");
    const ui = makeUi({ select, editor });

    const result = await toolFormPanel(ui, baseState);

    expect((result as ToolFormResult).description).toBe("");
  });

  it("sets approval and destination", async () => {
    const select = queue("Set approval", "Yes", "Set destination", "project", "Save");
    const ui = makeUi({ select });

    const result = await toolFormPanel(ui, baseState);

    expect((result as ToolFormResult).requiresApproval).toBe(true);
    expect((result as ToolFormResult).destination).toBe("project");
  });
});

describe("toolFormPanel re-draft", () => {
  it("applies fields returned by the re-draft callback", async () => {
    const select = queue("Re-draft", "Save");
    const input = queue("make it faster");
    const ui = makeUi({ select, input });
    const onRedraft = vi.fn().mockResolvedValue({ command: "npm test --silent", requiresApproval: true });

    const result = await toolFormPanel(ui, baseState, { onRedraft });

    expect(onRedraft).toHaveBeenCalledWith(expect.objectContaining({ name: "run_tests" }), "make it faster");
    expect((result as ToolFormResult).command).toBe("npm test --silent");
    expect((result as ToolFormResult).requiresApproval).toBe(true);
    expect((result as ToolFormResult).name).toBe("run_tests");
  });

  it("notifies and returns to review when re-draft fails", async () => {
    const select = queue("Re-draft", "Save");
    const input = queue("make it faster");
    const notify = vi.fn();
    const ui = makeUi({ select, input, notify });
    const onRedraft = vi.fn().mockRejectedValue(new Error("boom"));

    const result = await toolFormPanel(ui, baseState, { onRedraft });

    expect(notify).toHaveBeenCalledWith("Re-draft failed", "error");
    expect((result as ToolFormResult).name).toBe("run_tests");
  });

  it("notifies and returns to review when re-draft returns null", async () => {
    const select = queue("Re-draft", "Save");
    const input = queue("make it faster");
    const notify = vi.fn();
    const ui = makeUi({ select, input, notify });
    const onRedraft = vi.fn().mockResolvedValue(null);

    const result = await toolFormPanel(ui, baseState, { onRedraft });

    expect(notify).toHaveBeenCalledWith("Re-draft unavailable", "error");
    expect((result as ToolFormResult).name).toBe("run_tests");
  });

  it("does not offer re-draft when no callback is provided", async () => {
    const select = queue("Save");
    const ui = makeUi({ select });

    await toolFormPanel(ui, baseState);

    const options = select.mock.calls[0]?.[1] as string[];
    expect(options).not.toContain("Re-draft");
  });
});

describe("toolFormPanel rejection and fail-closed cancellation", () => {
  it("rejects with the provided reason", async () => {
    const select = queue("Reject");
    const input = queue("not needed");
    const ui = makeUi({ select, input });

    const result = await toolFormPanel(ui, baseState);

    expect(result).toEqual({ rejected: true, reason: "not needed" });
  });

  it("returns to review when the rejection reason prompt is cancelled", async () => {
    const select = queue("Reject", "Save");
    const input = queue(undefined);
    const ui = makeUi({ select, input });

    const result = await toolFormPanel(ui, baseState);

    expect((result as ToolFormResult).name).toBe("run_tests");
  });

  it("fails closed as a rejection when the review menu is cancelled", async () => {
    const select = queue(undefined);
    const ui = makeUi({ select });

    const result = await toolFormPanel(ui, baseState);

    expect(result).toEqual({ rejected: true, reason: "" });
  });

  it("fails closed as a rejection on an unexpected menu response", async () => {
    const select = queue("Do something unexpected");
    const ui = makeUi({ select });

    const result = await toolFormPanel(ui, baseState);

    expect(result).toEqual({ rejected: true, reason: "" });
  });

  it("fails closed on an out-of-range edit guideline index", async () => {
    const select = queue("Edit guideline 5");
    const ui = makeUi({ select });

    const result = await toolFormPanel(ui, { ...baseState, guidelines: ["first"] });

    expect(result).toEqual({ rejected: true, reason: "" });
  });

  it("fails closed on an out-of-range remove guideline index", async () => {
    const select = queue("Remove guideline 5");
    const ui = makeUi({ select });

    const result = await toolFormPanel(ui, { ...baseState, guidelines: ["first"] });

    expect(result).toEqual({ rejected: true, reason: "" });
  });
});
