import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArmoryTool } from "../src/config.js";

vi.mock("../src/config.js", () => ({
  loadToolsWithSource: vi.fn(),
  loadToolWithSource: vi.fn(),
  removeFromConfig: vi.fn(),
  saveConfig: vi.fn(),
}));

vi.mock("../src/register-tool.js", () => {
  const sessionRegistry = new Map<string, ArmoryTool>();
  const approvalRegistry = new Map<string, ArmoryTool>();
  return {
    registerArmoryTool: vi.fn(),
    sessionRegistry,
    approvalRegistry,
  };
});

vi.mock("../src/shared.js", () => ({
  buildToolFromResult: vi.fn((result: Record<string, unknown>) => ({
    name: result.name,
    command: result.command,
    description: result.description,
  })),
  showToolEditor: vi.fn(),
}));

vi.mock("../src/onboard.js", () => ({
  handleOnboard: vi.fn().mockResolvedValue(undefined),
}));

import { type ArmoryCommandDeps, registerArmoryCommand } from "../src/commands.js";
import { loadToolsWithSource, loadToolWithSource, removeFromConfig, saveConfig } from "../src/config.js";
import { handleOnboard } from "../src/onboard.js";
import { approvalRegistry, registerArmoryTool, sessionRegistry } from "../src/register-tool.js";
import { buildToolFromResult, showToolEditor } from "../src/shared.js";

const toolProject: ArmoryTool = {
  name: "run_tests",
  command: "npm test",
  description: "Run tests",
};
const toolGlobal: ArmoryTool = {
  name: "global_tool",
  command: "echo global",
  description: "A global tool",
};
const toolSession: ArmoryTool = {
  name: "session_tool",
  command: "echo session",
  description: "A session tool",
};

function makePi() {
  return {
    registerCommand: vi.fn(),
    getActiveTools: vi.fn(() => ["run_tests", "session_tool", "global_tool"]),
    setActiveTools: vi.fn(),
  };
}

function makeDeps(overrides: Partial<ArmoryCommandDeps> = {}): ArmoryCommandDeps {
  return {
    tools: [toolProject],
    projectRoot: "/project",
    ...overrides,
  };
}

function makeCtx(overrides: { selectResponses?: (string | null)[]; customResponse?: unknown } = {}) {
  const selectQueue = [...(overrides.selectResponses ?? [])];
  return {
    ui: {
      notify: vi.fn(),
      select: vi.fn(async () => selectQueue.shift() ?? null),
      custom: vi.fn().mockResolvedValue(overrides.customResponse ?? null),
    },
    modelRegistry: {},
    model: undefined,
  };
}

function getHandler(pi: ReturnType<typeof makePi>): (args: string, ctx: unknown) => Promise<void> {
  const call = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0];
  return call[1].handler;
}

function plainTheme() {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
}

describe("handleEdit", () => {
  beforeEach(() => {
    sessionRegistry.clear();
    approvalRegistry.clear();
    vi.mocked(loadToolsWithSource).mockReset();
    vi.mocked(loadToolWithSource).mockReset();
    vi.mocked(saveConfig).mockResolvedValue(undefined);
    vi.mocked(removeFromConfig).mockResolvedValue(undefined);
    vi.mocked(registerArmoryTool).mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("edits a session tool staying session — no confirmation, updates registry", async () => {
    sessionRegistry.set("session_tool", toolSession);
    const updatedTool = { name: "session_tool", command: "echo updated", description: "updated" };
    vi.mocked(showToolEditor).mockResolvedValue({
      name: "session_tool",
      command: "echo updated",
      description: "updated",
      guidelines: [],
      requiresApproval: false,
      destination: "session",
    });
    vi.mocked(buildToolFromResult).mockReturnValue(updatedTool);

    const pi = makePi();
    const deps = makeDeps({ tools: [] });
    const ctx = makeCtx();
    registerArmoryCommand(pi as never, deps);
    const handler = getHandler(pi);
    await handler("edit session_tool", ctx as never);

    // No confirmation needed (destination unchanged)
    expect(ctx.ui.select).not.toHaveBeenCalled();
    // Updated in session registry
    expect(sessionRegistry.get("session_tool")).toEqual(updatedTool);
    // Never saved to config
    expect(saveConfig).not.toHaveBeenCalled();
    expect(registerArmoryTool).toHaveBeenCalledWith(pi, updatedTool);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Tool 'session_tool' updated", "info");
  });

  it("promoting session → project requires confirmation and saves to config", async () => {
    sessionRegistry.set("session_tool", toolSession);
    const updatedTool = { name: "session_tool", command: "echo session", description: "A session tool" };
    vi.mocked(showToolEditor).mockResolvedValue({
      name: "session_tool",
      command: "echo session",
      description: "A session tool",
      guidelines: [],
      requiresApproval: false,
      destination: "project", // promoting
    });
    vi.mocked(buildToolFromResult).mockReturnValue(updatedTool);

    const pi = makePi();
    const deps = makeDeps({ tools: [] });
    // User confirms the scope change
    const ctx = makeCtx({ selectResponses: ["Confirm"] });
    registerArmoryCommand(pi as never, deps);
    const handler = getHandler(pi);
    await handler("edit session_tool", ctx as never);

    // Confirmation was shown
    expect(ctx.ui.select).toHaveBeenCalledOnce();
    const [confirmMsg, confirmOptions] = (ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(confirmMsg).toContain("session_tool");
    expect(confirmMsg).toContain(".pi/armory.json");
    expect(confirmOptions).toContain("Confirm");
    expect(confirmOptions).toContain("Cancel");

    // Saved to project config
    expect(saveConfig).toHaveBeenCalledWith(updatedTool, "project", "/project");
    // Removed from session registry
    expect(sessionRegistry.has("session_tool")).toBe(false);
    // Added to deps.tools
    expect(deps.tools).toContainEqual(updatedTool);
  });

  it("promoting session → project aborts if confirmation cancelled", async () => {
    sessionRegistry.set("session_tool", toolSession);
    vi.mocked(showToolEditor).mockResolvedValue({
      name: "session_tool",
      command: "echo session",
      description: "A session tool",
      guidelines: [],
      requiresApproval: false,
      destination: "project",
    });

    const pi = makePi();
    const deps = makeDeps({ tools: [] });
    // User cancels
    const ctx = makeCtx({ selectResponses: ["Cancel"] });
    registerArmoryCommand(pi as never, deps);
    const handler = getHandler(pi);
    await handler("edit session_tool", ctx as never);

    expect(saveConfig).not.toHaveBeenCalled();
    // Session registry unchanged
    expect(sessionRegistry.get("session_tool")).toEqual(toolSession);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("promoting a renamed shadowing session tool preserves the shadowed persisted tool", async () => {
    const sessionShadow: ArmoryTool = {
      name: "run_tests",
      command: "npm test -- --watch",
      description: "Session shadow",
    };
    const promotedTool = { name: "watch_tests", command: "npm test -- --watch", description: "Session shadow" };
    sessionRegistry.set("run_tests", sessionShadow);
    vi.mocked(loadToolWithSource).mockResolvedValue({ tool: toolProject, source: "project" });
    vi.mocked(showToolEditor).mockResolvedValue({
      name: "watch_tests",
      command: "npm test -- --watch",
      description: "Session shadow",
      guidelines: [],
      requiresApproval: false,
      destination: "project",
    });
    vi.mocked(buildToolFromResult).mockReturnValue(promotedTool);

    const pi = makePi();
    const deps = makeDeps({ tools: [toolProject] });
    const ctx = makeCtx({ selectResponses: ["Confirm"] });
    registerArmoryCommand(pi as never, deps);
    const handler = getHandler(pi);
    await handler("edit run_tests", ctx as never);

    expect(saveConfig).toHaveBeenCalledWith(promotedTool, "project", "/project");
    expect(removeFromConfig).not.toHaveBeenCalled();
    expect(sessionRegistry.has("run_tests")).toBe(false);
    expect(deps.tools).toContainEqual(toolProject);
    expect(deps.tools).toContainEqual(promotedTool);
    expect(registerArmoryTool).toHaveBeenCalledWith(pi, promotedTool);
    expect(registerArmoryTool).toHaveBeenCalledWith(pi, toolProject);
  });

  it("demoting project → session requires confirmation and removes from config", async () => {
    vi.mocked(loadToolWithSource).mockResolvedValue({ tool: toolProject, source: "project" });
    const updatedTool = { name: "run_tests", command: "npm test", description: "Run tests" };
    vi.mocked(showToolEditor).mockResolvedValue({
      name: "run_tests",
      command: "npm test",
      description: "Run tests",
      guidelines: [],
      requiresApproval: false,
      destination: "session", // demoting
    });
    vi.mocked(buildToolFromResult).mockReturnValue(updatedTool);

    const pi = makePi();
    const deps = makeDeps();
    // User confirms
    const ctx = makeCtx({ selectResponses: ["Confirm"] });
    registerArmoryCommand(pi as never, deps);
    const handler = getHandler(pi);
    await handler("edit run_tests", ctx as never);

    // Confirmation shown with appropriate copy
    const [confirmMsg] = (ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(confirmMsg).toContain("run_tests");
    expect(confirmMsg).toContain("REMOVED");
    expect(confirmMsg).toContain(".pi/armory.json");

    // Removed from project config
    expect(removeFromConfig).toHaveBeenCalledWith("run_tests", "project", "/project");
    // Added to session registry
    expect(sessionRegistry.get("run_tests")).toEqual(updatedTool);
    // Removed from deps.tools
    expect(deps.tools.find((t) => t.name === "run_tests")).toBeUndefined();
    // Never saved to config
    expect(saveConfig).not.toHaveBeenCalled();
  });

  it("demoting project → session aborts if confirmation cancelled", async () => {
    vi.mocked(loadToolWithSource).mockResolvedValue({ tool: toolProject, source: "project" });
    vi.mocked(showToolEditor).mockResolvedValue({
      name: "run_tests",
      command: "npm test",
      description: "Run tests",
      guidelines: [],
      requiresApproval: false,
      destination: "session",
    });

    const pi = makePi();
    const deps = makeDeps();
    // User cancels
    const ctx = makeCtx({ selectResponses: ["Cancel"] });
    registerArmoryCommand(pi as never, deps);
    const handler = getHandler(pi);
    await handler("edit run_tests", ctx as never);

    expect(removeFromConfig).not.toHaveBeenCalled();
    expect(sessionRegistry.has("run_tests")).toBe(false);
    // deps.tools unchanged
    expect(deps.tools).toContainEqual(toolProject);
  });

  it("global → session confirmation message mentions global config", async () => {
    vi.mocked(loadToolWithSource).mockResolvedValue({ tool: toolGlobal, source: "global" });
    const updatedTool = { name: "global_tool", command: "echo global", description: "A global tool" };
    vi.mocked(showToolEditor).mockResolvedValue({
      name: "global_tool",
      command: "echo global",
      description: "A global tool",
      guidelines: [],
      requiresApproval: false,
      destination: "session",
    });
    vi.mocked(buildToolFromResult).mockReturnValue(updatedTool);

    const pi = makePi();
    const deps = makeDeps({ tools: [toolGlobal] });
    const ctx = makeCtx({ selectResponses: ["Confirm"] });
    registerArmoryCommand(pi as never, deps);
    const handler = getHandler(pi);
    await handler("edit global_tool", ctx as never);

    const [confirmMsg] = (ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(confirmMsg).toContain("global_tool");
    expect(confirmMsg).toContain("~/.pi/agent/armory.json");
  });

  it("moving project → global requires confirmation, saves global, and removes project", async () => {
    vi.mocked(loadToolWithSource).mockResolvedValue({ tool: toolProject, source: "project" });
    vi.mocked(showToolEditor).mockResolvedValue({
      name: "run_tests",
      command: "npm test",
      description: "Run tests",
      guidelines: [],
      requiresApproval: false,
      destination: "global",
    });
    vi.mocked(buildToolFromResult).mockReturnValue(toolProject);

    const pi = makePi();
    const deps = makeDeps();
    const ctx = makeCtx({ selectResponses: ["Confirm"] });
    registerArmoryCommand(pi as never, deps);
    const handler = getHandler(pi);
    await handler("edit run_tests", ctx as never);

    const [confirmMsg] = (ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(confirmMsg).toContain("available in all projects");
    expect(saveConfig).toHaveBeenCalledWith(toolProject, "global", "/project");
    expect(removeFromConfig).toHaveBeenCalledWith("run_tests", "project", "/project");
  });

  it("moving global → project requires confirmation, saves project, and removes global", async () => {
    vi.mocked(loadToolWithSource).mockResolvedValue({ tool: toolGlobal, source: "global" });
    vi.mocked(showToolEditor).mockResolvedValue({
      name: "global_tool",
      command: "echo global",
      description: "A global tool",
      guidelines: [],
      requiresApproval: false,
      destination: "project",
    });
    vi.mocked(buildToolFromResult).mockReturnValue(toolGlobal);

    const pi = makePi();
    const deps = makeDeps({ tools: [toolGlobal] });
    const ctx = makeCtx({ selectResponses: ["Confirm"] });
    registerArmoryCommand(pi as never, deps);
    const handler = getHandler(pi);
    await handler("edit global_tool", ctx as never);

    const [confirmMsg] = (ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(confirmMsg).toContain("only be available in this project");
    expect(saveConfig).toHaveBeenCalledWith(toolGlobal, "project", "/project");
    expect(removeFromConfig).toHaveBeenCalledWith("global_tool", "global", "/project");
  });

  it("same-destination persisted edit requires no confirmation", async () => {
    vi.mocked(loadToolWithSource).mockResolvedValue({ tool: toolProject, source: "project" });
    const updatedTool = { name: "run_tests", command: "npm test --watch", description: "Run tests" };
    vi.mocked(showToolEditor).mockResolvedValue({
      name: "run_tests",
      command: "npm test --watch",
      description: "Run tests",
      guidelines: [],
      requiresApproval: false,
      destination: "project",
    });
    vi.mocked(buildToolFromResult).mockReturnValue(updatedTool);

    const pi = makePi();
    const deps = makeDeps();
    const ctx = makeCtx();
    registerArmoryCommand(pi as never, deps);
    const handler = getHandler(pi);
    await handler("edit run_tests", ctx as never);

    // No confirmation select
    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(saveConfig).toHaveBeenCalledWith(updatedTool, "project", "/project");
    expect(ctx.ui.notify).toHaveBeenCalledWith("Tool 'run_tests' updated", "info");
  });

  it("uses the custom scrollable picker when editing without a tool name", async () => {
    vi.mocked(loadToolsWithSource).mockResolvedValue([{ tool: toolProject, source: "project" }]);
    vi.mocked(loadToolWithSource).mockResolvedValue({ tool: toolProject, source: "project" });
    const updatedTool = { name: "run_tests", command: "npm test --watch", description: "Run tests" };
    vi.mocked(showToolEditor).mockResolvedValue({
      name: "run_tests",
      command: "npm test --watch",
      description: "Run tests",
      guidelines: [],
      requiresApproval: false,
      destination: "project",
    });
    vi.mocked(buildToolFromResult).mockReturnValue(updatedTool);

    const pi = makePi();
    const deps = makeDeps();
    const ctx = makeCtx({ customResponse: "run_tests" });
    registerArmoryCommand(pi as never, deps);
    const handler = getHandler(pi);
    await handler("edit", ctx as never);

    expect(loadToolsWithSource).toHaveBeenCalledWith("/project");
    expect(ctx.ui.custom).toHaveBeenCalledOnce();
    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(showToolEditor).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ name: "run_tests", destination: "project" }),
      undefined,
    );
  });
});

describe("handleDelete", () => {
  beforeEach(() => {
    sessionRegistry.clear();
    approvalRegistry.clear();
    vi.mocked(loadToolsWithSource).mockReset();
    vi.mocked(loadToolWithSource).mockReset();
    vi.mocked(removeFromConfig).mockResolvedValue(undefined);
    vi.mocked(registerArmoryTool).mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("deletes a session tool — removes from registry, deactivates, no config change", async () => {
    sessionRegistry.set("session_tool", toolSession);

    const pi = makePi();
    const deps = makeDeps({ tools: [] });
    const ctx = makeCtx({ selectResponses: ["Delete"] });
    registerArmoryCommand(pi as never, deps);
    const handler = getHandler(pi);
    await handler("delete session_tool", ctx as never);

    // Confirmation was shown
    expect(ctx.ui.select).toHaveBeenCalledOnce();
    const [confirmMsg] = (ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(confirmMsg).toContain("session_tool");
    expect(confirmMsg).toContain("in memory");

    // Removed from session registry
    expect(sessionRegistry.has("session_tool")).toBe(false);
    // Deactivated via setActiveTools
    expect(pi.setActiveTools).toHaveBeenCalledWith(expect.not.arrayContaining(["session_tool"]));
    // Config never touched
    expect(removeFromConfig).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith("Tool 'session_tool' deleted", "info");
  });

  it("deletes a project tool — removes from config, deactivates, removes from deps.tools", async () => {
    vi.mocked(loadToolWithSource)
      .mockResolvedValueOnce({ tool: toolProject, source: "project" })
      .mockResolvedValueOnce(null);

    const pi = makePi();
    const deps = makeDeps();
    const ctx = makeCtx({ selectResponses: ["Delete"] });
    registerArmoryCommand(pi as never, deps);
    const handler = getHandler(pi);
    await handler("delete run_tests", ctx as never);

    const [confirmMsg] = (ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(confirmMsg).toContain("run_tests");
    expect(confirmMsg).toContain(".pi/armory.json");

    expect(removeFromConfig).toHaveBeenCalledWith("run_tests", "project", "/project");
    expect(deps.tools.find((t) => t.name === "run_tests")).toBeUndefined();
    expect(pi.setActiveTools).toHaveBeenCalledWith(expect.not.arrayContaining(["run_tests"]));
    expect(ctx.ui.notify).toHaveBeenCalledWith("Tool 'run_tests' deleted", "info");
  });

  it("deletes a global tool — confirmation mentions global config", async () => {
    vi.mocked(loadToolWithSource)
      .mockResolvedValueOnce({ tool: toolGlobal, source: "global" })
      .mockResolvedValueOnce(null);

    const pi = makePi();
    const deps = makeDeps({ tools: [toolGlobal] });
    const ctx = makeCtx({ selectResponses: ["Delete"] });
    registerArmoryCommand(pi as never, deps);
    const handler = getHandler(pi);
    await handler("delete global_tool", ctx as never);

    const [confirmMsg] = (ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(confirmMsg).toContain("global_tool");
    expect(confirmMsg).toContain("~/.pi/agent/armory.json");

    expect(removeFromConfig).toHaveBeenCalledWith("global_tool", "global", "/project");
  });

  it("delete aborts if confirmation cancelled — no changes", async () => {
    sessionRegistry.set("session_tool", toolSession);

    const pi = makePi();
    const deps = makeDeps({ tools: [] });
    const ctx = makeCtx({ selectResponses: ["Cancel"] });
    registerArmoryCommand(pi as never, deps);
    const handler = getHandler(pi);
    await handler("delete session_tool", ctx as never);

    expect(sessionRegistry.has("session_tool")).toBe(true);
    expect(removeFromConfig).not.toHaveBeenCalled();
    expect(pi.setActiveTools).not.toHaveBeenCalled();
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("also cleans approvalRegistry on delete", async () => {
    sessionRegistry.set("session_tool", toolSession);
    approvalRegistry.set("session_tool", { ...toolSession, requires_approval: true });

    const pi = makePi();
    const deps = makeDeps({ tools: [] });
    const ctx = makeCtx({ selectResponses: ["Delete"] });
    registerArmoryCommand(pi as never, deps);
    const handler = getHandler(pi);
    await handler("delete session_tool", ctx as never);

    expect(approvalRegistry.has("session_tool")).toBe(false);
  });

  it("shows the custom scrollable picker when no name given", async () => {
    sessionRegistry.set("session_tool", toolSession);
    vi.mocked(loadToolsWithSource).mockResolvedValue([]);

    const pi = makePi();
    const deps = makeDeps({ tools: [] });
    const ctx = makeCtx({ customResponse: "session_tool", selectResponses: ["Cancel"] });
    registerArmoryCommand(pi as never, deps);
    const handler = getHandler(pi);
    await handler("delete", ctx as never);

    expect(ctx.ui.custom).toHaveBeenCalledOnce();
    expect(ctx.ui.select).toHaveBeenCalledOnce();
    const [confirmPrompt] = (ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(confirmPrompt).toContain("session_tool");
  });

  it("falls back to ui.select when custom UI is unavailable", async () => {
    sessionRegistry.set("session_tool", toolSession);
    vi.mocked(loadToolsWithSource).mockResolvedValue([]);

    const pi = makePi();
    const deps = makeDeps({ tools: [] });
    const ctx = makeCtx({ selectResponses: ["session_tool", "Cancel"] });
    ctx.ui.custom = vi.fn().mockResolvedValue(undefined);
    registerArmoryCommand(pi as never, deps);
    const handler = getHandler(pi);
    await handler("delete", ctx as never);

    expect(ctx.ui.custom).toHaveBeenCalledOnce();
    expect(ctx.ui.select).toHaveBeenCalledTimes(2);
    const [pickerPrompt] = (ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(pickerPrompt).toContain("delete");
  });

  it("picker renders source labels and supports tabbing to session scope", async () => {
    sessionRegistry.set("session_tool", toolSession);
    vi.mocked(loadToolsWithSource).mockResolvedValue([
      { tool: toolProject, source: "project" },
      { tool: toolGlobal, source: "global" },
    ]);

    const rendered: string[] = [];
    const ctx = makeCtx();
    ctx.ui.custom = vi.fn(async (factory: unknown) => {
      const component = (
        factory as (
          tui: unknown,
          theme: unknown,
          keybindings: unknown,
          done: (value: string | null) => void,
        ) => {
          render(width: number): string[];
          handleInput(data: string): void;
        }
      )({ requestRender: vi.fn() }, plainTheme(), undefined, vi.fn());

      rendered.push(component.render(120).join("\n"));
      component.handleInput("\t");
      rendered.push(component.render(120).join("\n"));
      return null;
    });

    const pi = makePi();
    const deps = makeDeps({ tools: [] });
    registerArmoryCommand(pi as never, deps);
    const handler = getHandler(pi);
    await handler("delete", ctx as never);

    expect(rendered[0]).toContain("[session]");
    expect(rendered[0]).toContain("[project]");
    expect(rendered[0]).toContain("[global]");
    expect(rendered[1]).toContain("Session");
    expect(rendered[1]).toContain("[session]");
    expect(rendered[1]).not.toContain("[project]");
    expect(rendered[1]).not.toContain("[global]");
  });
});

describe("command completions", () => {
  it("includes delete in top-level completions", () => {
    const pi = makePi();
    const deps = makeDeps();
    registerArmoryCommand(pi as never, deps);
    const { getArgumentCompletions } = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0][1];
    const completions = getArgumentCompletions("");
    const values = completions?.map((c: { value: string }) => c.value) ?? [];
    expect(values).toContain("delete");
  });

  it("completes delete with session tool names", () => {
    sessionRegistry.set("session_tool", toolSession);

    const pi = makePi();
    const deps = makeDeps({ tools: [] });
    registerArmoryCommand(pi as never, deps);
    const { getArgumentCompletions } = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0][1];
    const completions = getArgumentCompletions("delete ");
    const values = completions?.map((c: { value: string }) => c.value) ?? [];
    expect(values).toContain("delete session_tool");

    sessionRegistry.clear();
  });

  it("completes edit with session tool names", () => {
    sessionRegistry.set("session_tool", toolSession);

    const pi = makePi();
    const deps = makeDeps({ tools: [toolProject] });
    registerArmoryCommand(pi as never, deps);
    const { getArgumentCompletions } = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0][1];
    const completions = getArgumentCompletions("edit ");
    const values = completions?.map((c: { value: string }) => c.value) ?? [];
    expect(values).toContain("edit session_tool");
    expect(values).toContain("edit run_tests");

    sessionRegistry.clear();
  });

  it("includes onboard in top-level completions", () => {
    const pi = makePi();
    const deps = makeDeps();
    registerArmoryCommand(pi as never, deps);
    const { getArgumentCompletions } = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0][1];
    const completions = getArgumentCompletions("");
    const values = completions?.map((c: { value: string }) => c.value) ?? [];
    expect(values).toContain("onboard");
  });
});

describe("handleOnboard command routing", () => {
  afterEach(() => vi.clearAllMocks());

  it("routes 'onboard' to handleOnboard with correct args", async () => {
    const pi = makePi();
    const deps = makeDeps({ draftModelName: "provider:model" });
    const ctx = makeCtx();
    registerArmoryCommand(pi as never, deps);
    const handler = getHandler(pi);
    await handler("onboard", ctx as never);

    expect(vi.mocked(handleOnboard)).toHaveBeenCalledWith(pi, ctx, "/project", "provider:model");
  });

  it("routes 'onboard' without a draftModelName when none configured", async () => {
    const pi = makePi();
    const deps = makeDeps(); // no draftModelName
    const ctx = makeCtx();
    registerArmoryCommand(pi as never, deps);
    const handler = getHandler(pi);
    await handler("onboard", ctx as never);

    expect(vi.mocked(handleOnboard)).toHaveBeenCalledWith(pi, ctx, "/project", undefined);
  });

  it("shows error notification for unknown sub-command (not onboard)", async () => {
    const pi = makePi();
    const deps = makeDeps();
    const ctx = makeCtx();
    registerArmoryCommand(pi as never, deps);
    const handler = getHandler(pi);
    await handler("unknown_sub", ctx as never);

    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("onboard"), "error");
  });
});
