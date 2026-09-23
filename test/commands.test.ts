import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArmoryTool } from "../src/config.js";

vi.mock("../src/config.js", () => ({
  getDestinationEnvSets: vi.fn(),
  loadToolInDestination: vi.fn(),
  loadToolsWithSource: vi.fn(),
  loadToolWithSource: vi.fn(),
  removeFromConfig: vi.fn(),
  saveConfig: vi.fn(),
}));

vi.mock("../src/register-tool.js", () => {
  const sessionRegistry = new Map<string, ArmoryTool>();
  const approvalRegistry = new Map<string, ArmoryTool>();
  const toolRegistry = new Map<string, ArmoryTool>();
  return {
    registerArmoryTool: vi.fn(),
    sessionRegistry,
    approvalRegistry,
    toolRegistry,
  };
});

vi.mock("../src/shared.js", () => ({
  buildToolFromResult: vi.fn((result: Record<string, unknown>) => ({
    name: result.name,
    command: result.command,
    description: result.description,
  })),
  showToolEditor: vi.fn(),
  syncToolCondition: vi.fn(),
}));

vi.mock("../src/onboard.js", () => ({
  handleOnboard: vi.fn().mockResolvedValue(undefined),
}));

import { type ArmoryCommandDeps, registerArmoryCommand } from "../src/commands.js";
import {
  getDestinationEnvSets,
  loadToolInDestination,
  loadToolsWithSource,
  loadToolWithSource,
  removeFromConfig,
  saveConfig,
} from "../src/config.js";
import { handleOnboard } from "../src/onboard.js";
import { approvalRegistry, registerArmoryTool, sessionRegistry, toolRegistry } from "../src/register-tool.js";
import { buildToolFromResult, showToolEditor, syncToolCondition } from "../src/shared.js";

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

function makeCtx(overrides: { selectResponses?: (string | null)[]; mode?: string } = {}) {
  const selectQueue = [...(overrides.selectResponses ?? [])];
  return {
    mode: overrides.mode ?? "tui",
    cwd: "/project",
    ui: {
      notify: vi.fn(),
      select: vi.fn(async () => selectQueue.shift() ?? null),
    },
    modelRegistry: {},
    model: undefined,
  };
}

function getHandler(pi: ReturnType<typeof makePi>): (args: string, ctx: unknown) => Promise<void> {
  const call = (pi.registerCommand as ReturnType<typeof vi.fn>).mock.calls[0];
  return call[1].handler;
}

describe("handleEdit", () => {
  beforeEach(() => {
    sessionRegistry.clear();
    approvalRegistry.clear();
    toolRegistry.clear();
    vi.mocked(loadToolsWithSource).mockReset();
    vi.mocked(loadToolWithSource).mockReset();
    vi.mocked(loadToolInDestination).mockReset();
    vi.mocked(loadToolInDestination).mockResolvedValue(null);
    vi.mocked(getDestinationEnvSets).mockReset();
    vi.mocked(getDestinationEnvSets).mockResolvedValue({});
    vi.mocked(saveConfig).mockReset();
    vi.mocked(saveConfig).mockResolvedValue({});
    vi.mocked(removeFromConfig).mockReset();
    vi.mocked(removeFromConfig).mockResolvedValue(undefined);
    vi.mocked(registerArmoryTool).mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("notifies and returns early when ctx.mode is not 'tui' — no showToolEditor/model/persistence work", async () => {
    const pi = makePi();
    const deps = makeDeps();
    const ctx = makeCtx({ mode: "rpc" });
    registerArmoryCommand(pi as never, deps);
    const handler = getHandler(pi);
    await handler("edit run_tests", ctx as never);

    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("TUI"), "error");
    expect(showToolEditor).not.toHaveBeenCalled();
    expect(loadToolWithSource).not.toHaveBeenCalled();
    expect(loadToolsWithSource).not.toHaveBeenCalled();
    expect(saveConfig).not.toHaveBeenCalled();
    expect(removeFromConfig).not.toHaveBeenCalled();
    expect(registerArmoryTool).not.toHaveBeenCalled();
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
    expect(saveConfig).toHaveBeenCalledWith(updatedTool, "project", "/project", undefined, {});
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
    const shadowedTool: ArmoryTool = { ...toolProject, envFrom: ["global_env"] };
    sessionRegistry.set("run_tests", sessionShadow);
    const projectSets = { project_env: { TOKEN: "project" } };
    const globalSets = { global_env: { TOKEN: "global" } };
    vi.mocked(getDestinationEnvSets).mockImplementation(async (source) =>
      source === "project" ? projectSets : globalSets,
    );
    vi.mocked(loadToolWithSource).mockResolvedValue({ tool: shadowedTool, source: "global" });
    vi.mocked(showToolEditor).mockResolvedValue({
      name: "watch_tests",
      command: "npm test -- --watch",
      description: "Session shadow",
      guidelines: [],
      requiresApproval: false,
      destination: "project",
    });
    vi.mocked(buildToolFromResult).mockReturnValue(promotedTool);
    vi.mocked(saveConfig).mockResolvedValue(projectSets);

    const pi = makePi();
    const deps = makeDeps({ tools: [shadowedTool] });
    const ctx = makeCtx({ selectResponses: ["Confirm"] });
    registerArmoryCommand(pi as never, deps);
    const handler = getHandler(pi);
    await handler("edit run_tests", ctx as never);

    expect(saveConfig).toHaveBeenCalledWith(promotedTool, "project", "/project", undefined, projectSets);
    expect(removeFromConfig).not.toHaveBeenCalled();
    expect(sessionRegistry.has("run_tests")).toBe(false);
    expect(deps.tools).toContainEqual(shadowedTool);
    expect(deps.tools).toContainEqual(promotedTool);
    expect(registerArmoryTool).toHaveBeenCalledWith(pi, promotedTool, projectSets);
    expect(registerArmoryTool).toHaveBeenCalledWith(pi, shadowedTool, globalSets);
    expect(getDestinationEnvSets).toHaveBeenCalledWith("global", "/project");
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
    expect(loadToolInDestination).toHaveBeenCalledWith("run_tests", "global", "/project");
    expect(saveConfig).toHaveBeenCalledWith(toolProject, "global", "/project", undefined, {});
    expect(removeFromConfig).toHaveBeenCalledWith("run_tests", "project", "/project");
    expect(registerArmoryTool).toHaveBeenCalledWith(pi, toolProject, {});
    expect(ctx.ui.notify).toHaveBeenCalledWith("Tool 'run_tests' updated", "info");
  });

  it("does not write when the destination snapshot cannot be loaded", async () => {
    vi.mocked(loadToolWithSource).mockResolvedValue({ tool: toolProject, source: "project" });
    vi.mocked(loadToolInDestination).mockRejectedValue(new Error("secret destination detail"));
    vi.mocked(showToolEditor).mockResolvedValue({ ...toolProject, destination: "global" });
    const pi = makePi();
    const deps = makeDeps();
    const ctx = makeCtx({ selectResponses: ["Confirm"] });
    registerArmoryCommand(pi as never, deps);
    await getHandler(pi)("edit run_tests", ctx as never);

    expect(saveConfig).not.toHaveBeenCalled();
    expect(removeFromConfig).not.toHaveBeenCalled();
    expect(deps.tools).toEqual([toolProject]);
    expect(registerArmoryTool).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Review the config and retry"), "error");
    expect(ctx.ui.notify.mock.calls.flat().join(" ")).not.toContain("secret destination detail");
  });

  it("rolls back a newly created destination when source removal fails, without changing runtime state", async () => {
    const oldTool: ArmoryTool = { ...toolProject, requires_approval: true };
    const movedTool: ArmoryTool = { ...oldTool, command: "npm test --watch" };
    vi.mocked(loadToolWithSource).mockResolvedValue({ tool: oldTool, source: "project" });
    vi.mocked(showToolEditor).mockResolvedValue({ ...movedTool, destination: "global" });
    vi.mocked(buildToolFromResult).mockReturnValue(movedTool);
    vi.mocked(removeFromConfig).mockRejectedValueOnce(new Error("secret source detail"));
    approvalRegistry.set(oldTool.name, oldTool);
    toolRegistry.set(oldTool.name, oldTool);
    const pi = makePi();
    const deps = makeDeps({ tools: [oldTool] });
    const ctx = makeCtx({ selectResponses: ["Confirm"] });
    registerArmoryCommand(pi as never, deps);
    await getHandler(pi)("edit run_tests", ctx as never);

    expect(loadToolInDestination).toHaveBeenCalledWith("run_tests", "global", "/project");
    expect(saveConfig).toHaveBeenCalledTimes(1);
    expect(saveConfig).toHaveBeenCalledWith(movedTool, "global", "/project", undefined, {});
    expect(vi.mocked(removeFromConfig).mock.calls).toEqual([
      ["run_tests", "project", "/project"],
      ["run_tests", "global", "/project"],
    ]);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Review the config and retry"), "error");
    expect(ctx.ui.notify.mock.calls.flat().join(" ")).not.toContain("secret source detail");
    expect(deps.tools).toEqual([oldTool]);
    expect(approvalRegistry.get(oldTool.name)).toBe(oldTool);
    expect(toolRegistry.get(oldTool.name)).toBe(oldTool);
    expect(sessionRegistry.size).toBe(0);
    expect(registerArmoryTool).not.toHaveBeenCalled();
    expect(syncToolCondition).not.toHaveBeenCalled();
    expect(pi.setActiveTools).not.toHaveBeenCalled();
  });

  it("restores the exact overwritten destination tool when source removal fails", async () => {
    const oldTool: ArmoryTool = { ...toolProject, requires_approval: true };
    const priorDestination: ArmoryTool = {
      ...toolProject,
      command: "echo prior",
      description: "prior",
      envFrom: ["global_set"],
    };
    vi.mocked(loadToolWithSource).mockResolvedValue({ tool: oldTool, source: "project" });
    vi.mocked(loadToolInDestination).mockResolvedValue(priorDestination);
    vi.mocked(showToolEditor).mockResolvedValue({ ...oldTool, destination: "global" });
    vi.mocked(buildToolFromResult).mockReturnValue(oldTool);
    vi.mocked(removeFromConfig).mockRejectedValueOnce(new Error("source write error"));
    const pi = makePi();
    const ctx = makeCtx({ selectResponses: ["Confirm"] });
    registerArmoryCommand(pi as never, makeDeps({ tools: [oldTool] }));
    await getHandler(pi)("edit run_tests", ctx as never);

    expect(loadToolInDestination).toHaveBeenCalledWith("run_tests", "global", "/project");
    expect(vi.mocked(saveConfig).mock.calls).toEqual([
      [oldTool, "global", "/project", undefined, {}],
      [priorDestination, "global", "/project"],
    ]);
    expect(removeFromConfig).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Review the config and retry"), "error");
    expect(registerArmoryTool).not.toHaveBeenCalled();
  });

  it("reports partial changes when rollback of a same-config rename also fails", async () => {
    const renamed: ArmoryTool = { ...toolProject, name: "renamed_tool" };
    vi.mocked(loadToolWithSource).mockResolvedValue({ tool: toolProject, source: "project" });
    vi.mocked(showToolEditor).mockResolvedValue({ ...renamed, destination: "project" });
    vi.mocked(buildToolFromResult).mockReturnValue(renamed);
    vi.mocked(removeFromConfig)
      .mockRejectedValueOnce(new Error("secret source detail"))
      .mockRejectedValueOnce(new Error("secret rollback detail"));
    const pi = makePi();
    const deps = makeDeps();
    const ctx = makeCtx();
    registerArmoryCommand(pi as never, deps);
    await getHandler(pi)("edit run_tests", ctx as never);

    expect(loadToolInDestination).toHaveBeenCalledWith("renamed_tool", "project", "/project");
    expect(saveConfig).toHaveBeenCalledWith(renamed, "project", "/project", undefined, {});
    expect(vi.mocked(removeFromConfig).mock.calls).toEqual([
      ["run_tests", "project", "/project"],
      ["renamed_tool", "project", "/project"],
    ]);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("configs may be partially changed"), "error");
    expect(ctx.ui.notify.mock.calls.flat().join(" ")).not.toMatch(/secret|updated/);
    expect(deps.tools).toEqual([toolProject]);
    expect(registerArmoryTool).not.toHaveBeenCalled();
    expect(pi.setActiveTools).not.toHaveBeenCalled();
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
    expect(confirmMsg).toContain("removed from global config");
    expect(confirmMsg).toContain("other projects will no longer have it");
    expect(saveConfig).toHaveBeenCalledWith(toolGlobal, "project", "/project", undefined, {});
    expect(removeFromConfig).toHaveBeenCalledWith("global_tool", "global", "/project");
  });

  it("same-destination persisted edit forwards env sets and inline env without confirmation", async () => {
    const existingTool: ArmoryTool = { ...toolProject, envFrom: ["common"], env: { INLINE: "value" } };
    const envSets = { common: { TOKEN: "secret" } };
    vi.mocked(getDestinationEnvSets).mockResolvedValue(envSets);
    vi.mocked(loadToolWithSource).mockResolvedValue({ tool: existingTool, source: "project" });
    const updatedTool = { ...existingTool, command: "npm test --watch" };
    vi.mocked(showToolEditor).mockResolvedValue({
      name: "run_tests",
      command: "npm test --watch",
      description: "Run tests",
      guidelines: [],
      requiresApproval: false,
      destination: "project",
    });
    vi.mocked(buildToolFromResult).mockReturnValue(updatedTool);
    vi.mocked(saveConfig).mockResolvedValue(envSets);

    const pi = makePi();
    const deps = makeDeps();
    const ctx = makeCtx();
    registerArmoryCommand(pi as never, deps);
    const handler = getHandler(pi);
    await handler("edit run_tests", ctx as never);

    // No confirmation select
    expect(ctx.ui.select).not.toHaveBeenCalled();
    expect(showToolEditor).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ envFrom: ["common"], envSets: { project: envSets, global: envSets } }),
      undefined,
    );
    expect(buildToolFromResult).toHaveBeenCalledWith(
      expect.objectContaining({ name: "run_tests", command: "npm test --watch" }),
      { env: existingTool.env, envFrom: existingTool.envFrom },
    );
    expect(saveConfig).toHaveBeenCalledWith(updatedTool, "project", "/project", undefined, envSets);
    expect(getDestinationEnvSets).toHaveBeenCalledWith("project", "/project");
    expect(registerArmoryTool).toHaveBeenCalledWith(pi, updatedTool, envSets);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Tool 'run_tests' updated", "info");
  });

  it("ignores an invalid unrelated scope while editing and registering from the valid scope", async () => {
    const projectSets = { local: { TOKEN: "project" } };
    const existing: ArmoryTool = { ...toolProject, envFrom: ["local"] };
    vi.mocked(getDestinationEnvSets).mockImplementation(async (scope) => {
      if (scope === "global") throw new Error("sensitive resolver detail");
      return projectSets;
    });
    vi.mocked(loadToolWithSource).mockResolvedValue({ tool: existing, source: "project" });
    vi.mocked(showToolEditor).mockResolvedValue({
      ...existing,
      guidelines: [],
      requiresApproval: false,
      destination: "project",
    });
    vi.mocked(buildToolFromResult).mockReturnValue(existing);
    vi.mocked(saveConfig).mockResolvedValue(projectSets);
    const pi = makePi();
    const ctx = makeCtx();
    registerArmoryCommand(pi as never, makeDeps());
    await getHandler(pi)("edit run_tests", ctx as never);

    expect(showToolEditor).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ envFrom: ["local"], envSets: { project: projectSets } }),
      undefined,
    );
    expect(saveConfig).toHaveBeenCalledWith(existing, "project", "/project", undefined, projectSets);
    expect(registerArmoryTool).toHaveBeenCalledWith(pi, existing, projectSets);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Tool 'run_tests' updated", "info");
  });

  it("preserves the old approval gate and registry when edited destination env sets cannot be loaded", async () => {
    const oldTool: ArmoryTool = { ...toolProject, requires_approval: true };
    approvalRegistry.set(oldTool.name, oldTool);
    toolRegistry.set(oldTool.name, oldTool);
    vi.mocked(loadToolWithSource).mockResolvedValue({ tool: oldTool, source: "project" });
    vi.mocked(showToolEditor).mockResolvedValue({
      name: "run_tests",
      command: "npm test --watch",
      description: "Run tests",
      guidelines: [],
      requiresApproval: false,
      destination: "project",
    });
    vi.mocked(buildToolFromResult).mockReturnValue({ ...toolProject, command: "npm test --watch" });
    vi.mocked(getDestinationEnvSets).mockRejectedValue(new Error("invalid config"));

    const pi = makePi();
    const deps = makeDeps({ tools: [oldTool] });
    const ctx = makeCtx();
    registerArmoryCommand(pi as never, deps);
    await getHandler(pi)("edit run_tests", ctx as never);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Fix the config"), "error");
    expect(showToolEditor).not.toHaveBeenCalled();
    expect(approvalRegistry.get(oldTool.name)).toBe(oldTool);
    expect(toolRegistry.get(oldTool.name)).toBe(oldTool);
    expect(deps.tools).toEqual([oldTool]);
    expect(pi.setActiveTools).not.toHaveBeenCalled();
    expect(saveConfig).not.toHaveBeenCalled();
    expect(removeFromConfig).not.toHaveBeenCalled();
    expect(registerArmoryTool).not.toHaveBeenCalled();
  });

  it("deactivates a renamed session name if revealing the persisted tool fails", async () => {
    const oldTool: ArmoryTool = { ...toolProject, requires_approval: true };
    const renamedTool: ArmoryTool = { ...oldTool, name: "renamed_tests" };
    sessionRegistry.set(oldTool.name, oldTool);
    approvalRegistry.set(oldTool.name, oldTool);
    toolRegistry.set(oldTool.name, oldTool);
    vi.mocked(loadToolWithSource).mockResolvedValue({ tool: toolProject, source: "global" });
    vi.mocked(getDestinationEnvSets).mockRejectedValue(new Error("invalid config"));
    vi.mocked(showToolEditor).mockResolvedValue({
      name: renamedTool.name,
      command: renamedTool.command,
      description: renamedTool.description,
      guidelines: [],
      requiresApproval: true,
      destination: "session",
    });
    vi.mocked(buildToolFromResult).mockReturnValue(renamedTool);

    const pi = makePi();
    let active = pi.getActiveTools();
    pi.getActiveTools.mockImplementation(() => active);
    pi.setActiveTools.mockImplementation((names) => {
      active = names;
    });
    registerArmoryCommand(pi as never, makeDeps());
    await expect(getHandler(pi)("edit run_tests", makeCtx() as never)).rejects.toThrow("invalid config");

    expect(sessionRegistry.has(oldTool.name)).toBe(false);
    expect(registerArmoryTool).toHaveBeenCalledWith(pi, renamedTool);
    expect(getDestinationEnvSets).toHaveBeenCalledWith("global", "/project");
    expect(active).not.toContain(oldTool.name);
    expect(toolRegistry.has(oldTool.name)).toBe(false);
    expect(approvalRegistry.has(oldTool.name)).toBe(false);
  });

  it("aborts without changes when the edited name is invalid/empty", async () => {
    sessionRegistry.set("session_tool", toolSession);
    vi.mocked(showToolEditor).mockResolvedValue({
      name: "   ",
      command: "echo updated",
      description: "updated",
      guidelines: [],
      requiresApproval: false,
      destination: "session",
    });

    const pi = makePi();
    const deps = makeDeps({ tools: [] });
    const ctx = makeCtx();
    registerArmoryCommand(pi as never, deps);
    const handler = getHandler(pi);
    await handler("edit session_tool", ctx as never);

    expect(saveConfig).not.toHaveBeenCalled();
    expect(removeFromConfig).not.toHaveBeenCalled();
    expect(registerArmoryTool).not.toHaveBeenCalled();
    expect(sessionRegistry.get("session_tool")).toEqual(toolSession);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("valid tool name"), "error");
  });

  it("aborts without changes when the edited name is reserved", async () => {
    sessionRegistry.set("session_tool", toolSession);
    vi.mocked(showToolEditor).mockResolvedValue({
      name: "request_tool",
      command: "echo updated",
      description: "updated",
      guidelines: [],
      requiresApproval: false,
      destination: "session",
    });

    const pi = makePi();
    const deps = makeDeps({ tools: [] });
    const ctx = makeCtx();
    registerArmoryCommand(pi as never, deps);
    const handler = getHandler(pi);
    await handler("edit session_tool", ctx as never);

    expect(saveConfig).not.toHaveBeenCalled();
    expect(removeFromConfig).not.toHaveBeenCalled();
    expect(registerArmoryTool).not.toHaveBeenCalled();
    expect(sessionRegistry.get("session_tool")).toEqual(toolSession);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("reserved name"), "error");
  });

  it("normalizes a valid human name before building/saving/registering", async () => {
    sessionRegistry.set("session_tool", toolSession);
    const updatedTool = { name: "my_new_tool", command: "echo updated", description: "updated" };
    vi.mocked(showToolEditor).mockResolvedValue({
      name: "My New Tool!",
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

    expect(buildToolFromResult).toHaveBeenCalledWith(
      expect.objectContaining({ name: "my_new_tool" }),
      expect.anything(),
    );
    expect(sessionRegistry.get("my_new_tool")).toEqual(updatedTool);
    expect(registerArmoryTool).toHaveBeenCalledWith(pi, updatedTool);
  });

  it("uses ui.select when editing without a tool name", async () => {
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
    const ctx = makeCtx({ selectResponses: ["run_tests"] });
    registerArmoryCommand(pi as never, deps);
    const handler = getHandler(pi);
    await handler("edit", ctx as never);

    expect(loadToolsWithSource).toHaveBeenCalledWith("/project");
    expect(ctx.ui.select).toHaveBeenCalledOnce();
    const [pickerPrompt, pickerNames] = (ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(pickerPrompt).toContain("edit");
    expect(pickerNames).toEqual(["run_tests"]);
    expect(showToolEditor).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ name: "run_tests", destination: "project" }),
      undefined,
    );
  });

  it("clears envFrom explicitly on edit and on confirmed session demotion", async () => {
    const existing: ArmoryTool = { ...toolProject, envFrom: ["local"], env: { INLINE: "kept" } };
    const cleared: ArmoryTool = { ...existing, envFrom: [] };
    vi.mocked(loadToolWithSource).mockResolvedValue({ tool: existing, source: "project" });
    vi.mocked(getDestinationEnvSets).mockResolvedValue({ local: { TOKEN: "secret" } });
    vi.mocked(showToolEditor).mockResolvedValue({
      ...existing,
      guidelines: [],
      requiresApproval: false,
      destination: "project",
      envFrom: [],
    });
    vi.mocked(buildToolFromResult).mockReturnValue(cleared);
    const pi = makePi();
    const deps = makeDeps({ tools: [existing] });
    registerArmoryCommand(pi as never, deps);
    await getHandler(pi)("edit run_tests", makeCtx() as never);
    expect(buildToolFromResult).toHaveBeenCalledWith(expect.objectContaining({ envFrom: [] }), {
      env: existing.env,
      envFrom: existing.envFrom,
    });
    expect(saveConfig).toHaveBeenCalledWith(cleared, "project", "/project", undefined, {
      local: { TOKEN: "secret" },
    });

    vi.mocked(showToolEditor).mockResolvedValue({
      ...existing,
      guidelines: [],
      requiresApproval: false,
      destination: "session",
      envFrom: [],
    });
    const ctx = makeCtx({ selectResponses: ["Confirm"] });
    await getHandler(pi)("edit run_tests", ctx as never);
    expect(sessionRegistry.get("run_tests")).toBe(cleared);
    expect(registerArmoryTool).toHaveBeenLastCalledWith(pi, cleared);
  });

  it("rejects selected env sets on session demotion without mutating anything", async () => {
    const existing: ArmoryTool = { ...toolProject, envFrom: ["local"], requires_approval: true };
    vi.mocked(loadToolWithSource).mockResolvedValue({ tool: existing, source: "project" });
    vi.mocked(getDestinationEnvSets).mockResolvedValue({ local: { TOKEN: "secret" } });
    vi.mocked(showToolEditor).mockResolvedValue({
      ...existing,
      guidelines: [],
      requiresApproval: true,
      destination: "session",
    });
    approvalRegistry.set(existing.name, existing);
    toolRegistry.set(existing.name, existing);
    const pi = makePi();
    const deps = makeDeps({ tools: [existing] });
    const ctx = makeCtx({ selectResponses: ["Confirm"] });
    registerArmoryCommand(pi as never, deps);
    await getHandler(pi)("edit run_tests", ctx as never);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Review the config"), "error");
    expect(saveConfig).not.toHaveBeenCalled();
    expect(removeFromConfig).not.toHaveBeenCalled();
    expect(registerArmoryTool).not.toHaveBeenCalled();
    expect(sessionRegistry.size).toBe(0);
    expect(deps.tools).toEqual([existing]);
    expect(approvalRegistry.get(existing.name)).toBe(existing);
    expect(toolRegistry.get(existing.name)).toBe(existing);
    expect(pi.setActiveTools).not.toHaveBeenCalled();
  });

  it("shows distinct destination definitions and refuses a missing selection on a move", async () => {
    const existing: ArmoryTool = { ...toolProject, envFrom: ["shared"] };
    const projectSets = { shared: { TOKEN: "project" } };
    const globalSets = { shared: { TOKEN: "global" } };
    vi.mocked(loadToolWithSource).mockResolvedValue({ tool: existing, source: "project" });
    vi.mocked(getDestinationEnvSets).mockImplementation(async (scope) =>
      scope === "project" ? projectSets : globalSets,
    );
    vi.mocked(showToolEditor).mockResolvedValue({
      ...existing,
      guidelines: [],
      requiresApproval: false,
      destination: "global",
      envFrom: ["missing"],
    });
    const pi = makePi();
    const deps = makeDeps({ tools: [existing] });
    const ctx = makeCtx({ selectResponses: ["Confirm"] });
    registerArmoryCommand(pi as never, deps);
    await getHandler(pi)("edit run_tests", ctx as never);
    expect(showToolEditor).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ envFrom: ["shared"], envSets: { project: projectSets, global: globalSets } }),
      undefined,
    );
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Review the config"), "error");
    expect(saveConfig).not.toHaveBeenCalled();
    expect(removeFromConfig).not.toHaveBeenCalled();
    expect(registerArmoryTool).not.toHaveBeenCalled();
    expect(deps.tools).toEqual([existing]);
  });

  it("leaves a same-name, different-definition move untouched when the form blocks rebind", async () => {
    const existing: ArmoryTool = { ...toolProject, envFrom: ["shared"] };
    const projectSets = { shared: { TOKEN: "project" } };
    const globalSets = { shared: { TOKEN: "global" } };
    vi.mocked(loadToolWithSource).mockResolvedValue({ tool: existing, source: "project" });
    vi.mocked(getDestinationEnvSets).mockImplementation(async (scope) =>
      scope === "project" ? projectSets : globalSets,
    );
    vi.mocked(showToolEditor).mockResolvedValue({ rejected: true, reason: "cancelled" });
    const pi = makePi();
    const deps = makeDeps({ tools: [existing] });
    registerArmoryCommand(pi as never, deps);
    await getHandler(pi)("edit run_tests", makeCtx() as never);
    expect(showToolEditor).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ envFrom: ["shared"], envSets: { project: projectSets, global: globalSets } }),
      undefined,
    );
    expect(saveConfig).not.toHaveBeenCalled();
    expect(removeFromConfig).not.toHaveBeenCalled();
    expect(registerArmoryTool).not.toHaveBeenCalled();
    expect(deps.tools).toEqual([existing]);
  });

  it("rejects a stale selected set before mutations and does not leak resolver details", async () => {
    const existing: ArmoryTool = { ...toolProject, envFrom: ["shared"], requires_approval: true };
    const projectSets = { shared: { TOKEN: "old" } };
    vi.mocked(loadToolWithSource).mockResolvedValue({ tool: existing, source: "project" });
    vi.mocked(getDestinationEnvSets).mockResolvedValue(projectSets);
    vi.mocked(showToolEditor).mockResolvedValue({
      ...existing,
      guidelines: [],
      requiresApproval: true,
      destination: "project",
    });
    vi.mocked(buildToolFromResult).mockReturnValue(existing);
    vi.mocked(saveConfig).mockRejectedValue(new Error("sensitive resolver detail"));
    approvalRegistry.set(existing.name, existing);
    toolRegistry.set(existing.name, existing);
    const pi = makePi();
    const deps = makeDeps({ tools: [existing] });
    const ctx = makeCtx();
    registerArmoryCommand(pi as never, deps);
    await getHandler(pi)("edit run_tests", ctx as never);
    expect(saveConfig).toHaveBeenCalledWith(existing, "project", "/project", undefined, projectSets);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("retry"), "error");
    expect(ctx.ui.notify.mock.calls.flat().join(" ")).not.toContain("sensitive resolver detail");
    expect(removeFromConfig).not.toHaveBeenCalled();
    expect(registerArmoryTool).not.toHaveBeenCalled();
    expect(deps.tools).toEqual([existing]);
    expect(approvalRegistry.get(existing.name)).toBe(existing);
    expect(toolRegistry.get(existing.name)).toBe(existing);
    expect(pi.setActiveTools).not.toHaveBeenCalled();
  });

  it("prevalidates the source on a move, then registers with the save snapshot when valid", async () => {
    const existing: ArmoryTool = { ...toolProject, envFrom: ["shared"] };
    const projectSets = { shared: { TOKEN: "same" } };
    const globalSets = { shared: { TOKEN: "same" } };
    vi.mocked(loadToolWithSource).mockResolvedValue({ tool: existing, source: "project" });
    vi.mocked(getDestinationEnvSets).mockImplementation(async (scope) =>
      scope === "project" ? projectSets : globalSets,
    );
    vi.mocked(showToolEditor).mockResolvedValue({
      ...existing,
      guidelines: [],
      requiresApproval: false,
      destination: "global",
    });
    vi.mocked(buildToolFromResult).mockReturnValue(existing);
    const pi = makePi();
    const deps = makeDeps({ tools: [existing] });
    registerArmoryCommand(pi as never, deps);
    vi.mocked(getDestinationEnvSets)
      .mockResolvedValueOnce(projectSets)
      .mockResolvedValueOnce(globalSets)
      .mockRejectedValueOnce(new Error("invalid source"));
    const ctx = makeCtx({ selectResponses: ["Confirm"] });
    await getHandler(pi)("edit run_tests", ctx as never);
    expect(saveConfig).not.toHaveBeenCalled();
    expect(removeFromConfig).not.toHaveBeenCalled();
    expect(registerArmoryTool).not.toHaveBeenCalled();
    expect(deps.tools).toEqual([existing]);
    expect(ctx.ui.notify.mock.calls.flat().join(" ")).not.toContain("invalid source");

    vi.mocked(saveConfig).mockResolvedValue({ shared: { TOKEN: "from-save" } });
    const nextCtx = makeCtx({ selectResponses: ["Confirm"] });
    await getHandler(pi)("edit run_tests", nextCtx as never);
    expect(saveConfig).toHaveBeenCalledWith(existing, "global", "/project", undefined, globalSets);
    expect(removeFromConfig).toHaveBeenCalledWith("run_tests", "project", "/project");
    expect(registerArmoryTool).toHaveBeenCalledWith(pi, existing, { shared: { TOKEN: "from-save" } });
  });

  it("passes the persisted tool's when to the editor and persists/syncs the returned when", async () => {
    const conditionedTool: ArmoryTool = {
      name: "jj_only",
      command: "jj st",
      description: "Show jj status",
      when: "jj",
    };
    vi.mocked(loadToolWithSource).mockResolvedValue({ tool: conditionedTool, source: "project" });
    const updatedTool: ArmoryTool = { name: "jj_only", command: "jj st", description: "Show jj status", when: "jj" };
    vi.mocked(showToolEditor).mockResolvedValue({
      name: "jj_only",
      command: "jj st",
      description: "Show jj status",
      guidelines: [],
      requiresApproval: false,
      destination: "project",
      when: "jj",
    });
    vi.mocked(buildToolFromResult).mockReturnValue(updatedTool);

    const pi = makePi();
    const deps = makeDeps({ tools: [conditionedTool] });
    const ctx = makeCtx();
    registerArmoryCommand(pi as never, deps);
    const handler = getHandler(pi);
    await handler("edit jj_only", ctx as never);

    expect(showToolEditor).toHaveBeenCalledWith(ctx, expect.objectContaining({ when: "jj" }), undefined);
    expect(saveConfig).toHaveBeenCalledWith(updatedTool, "project", "/project", undefined, {});
    expect(syncToolCondition).toHaveBeenCalledWith(pi, ctx.cwd, updatedTool);
  });
});

describe("handleDelete", () => {
  beforeEach(() => {
    sessionRegistry.clear();
    approvalRegistry.clear();
    toolRegistry.clear();
    vi.mocked(loadToolsWithSource).mockReset();
    vi.mocked(loadToolWithSource).mockReset();
    vi.mocked(getDestinationEnvSets).mockReset();
    vi.mocked(getDestinationEnvSets).mockResolvedValue({});
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

  it("deletes with no lower-precedence tool to restore — removes the name from toolRegistry", async () => {
    sessionRegistry.set("session_tool", toolSession);
    toolRegistry.set("session_tool", toolSession);
    vi.mocked(loadToolWithSource).mockResolvedValueOnce(null);

    const pi = makePi();
    const deps = makeDeps({ tools: [] });
    const ctx = makeCtx({ selectResponses: ["Delete"] });
    registerArmoryCommand(pi as never, deps);
    const handler = getHandler(pi);
    await handler("delete session_tool", ctx as never);

    expect(toolRegistry.has("session_tool")).toBe(false);
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

  it("deleting a shadowing session tool reveals a lower-precedence persisted conditional tool and syncs its state", async () => {
    const conditionedTool: ArmoryTool = {
      name: "run_tests",
      command: "jj st",
      description: "Revealed persisted tool",
      when: "jj",
      envFrom: ["global_env"],
    };
    const envSets = { global_env: { TOKEN: "global-secret" } };
    vi.mocked(getDestinationEnvSets).mockResolvedValue(envSets);
    sessionRegistry.set("run_tests", toolSession);
    vi.mocked(loadToolWithSource).mockResolvedValueOnce({ tool: conditionedTool, source: "global" });

    const pi = makePi();
    const deps = makeDeps({ tools: [conditionedTool] });
    const ctx = makeCtx({ selectResponses: ["Delete"] });
    registerArmoryCommand(pi as never, deps);
    const handler = getHandler(pi);
    await handler("delete run_tests", ctx as never);

    expect(getDestinationEnvSets).toHaveBeenCalledWith("global", "/project");
    expect(registerArmoryTool).toHaveBeenCalledWith(pi, conditionedTool, envSets);
    expect(syncToolCondition).toHaveBeenCalledWith(pi, ctx.cwd, conditionedTool);
  });

  it("deactivates a deleted name if revealing the persisted tool fails", async () => {
    const oldTool: ArmoryTool = { ...toolProject, requires_approval: true };
    sessionRegistry.set(oldTool.name, oldTool);
    approvalRegistry.set(oldTool.name, oldTool);
    toolRegistry.set(oldTool.name, oldTool);
    vi.mocked(loadToolWithSource).mockResolvedValue({ tool: toolProject, source: "global" });
    vi.mocked(getDestinationEnvSets).mockRejectedValue(new Error("invalid config"));

    const pi = makePi();
    let active = pi.getActiveTools();
    pi.getActiveTools.mockImplementation(() => active);
    pi.setActiveTools.mockImplementation((names) => {
      active = names;
    });
    registerArmoryCommand(pi as never, makeDeps());
    await expect(getHandler(pi)("delete run_tests", makeCtx({ selectResponses: ["Delete"] }) as never)).rejects.toThrow(
      "invalid config",
    );

    expect(sessionRegistry.has(oldTool.name)).toBe(false);
    expect(getDestinationEnvSets).toHaveBeenCalledWith("global", "/project");
    expect(registerArmoryTool).not.toHaveBeenCalled();
    expect(active).not.toContain(oldTool.name);
    expect(toolRegistry.has(oldTool.name)).toBe(false);
    expect(approvalRegistry.has(oldTool.name)).toBe(false);
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

  it("uses ui.select when no name given", async () => {
    sessionRegistry.set("session_tool", toolSession);
    vi.mocked(loadToolsWithSource).mockResolvedValue([]);

    const pi = makePi();
    const deps = makeDeps({ tools: [] });
    const ctx = makeCtx({ selectResponses: ["session_tool", "Cancel"] });
    registerArmoryCommand(pi as never, deps);
    const handler = getHandler(pi);
    await handler("delete", ctx as never);

    expect(ctx.ui.select).toHaveBeenCalledTimes(2);
    const [pickerPrompt, pickerNames] = (ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(pickerPrompt).toContain("delete");
    expect(pickerNames).toEqual(["session_tool"]);
    const [confirmPrompt] = (ctx.ui.select as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(confirmPrompt).toContain("session_tool");
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
