import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArmoryTool } from "../src/config.js";

vi.mock("../src/config.js");
vi.mock("../src/register-tool.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/register-tool.js")>();
  return {
    ...actual,
    registerArmoryTool: vi.fn(actual.registerArmoryTool),
  };
});
vi.mock("../src/request-tool.js");
vi.mock("../src/commands.js");
vi.mock("../src/executor.js");
vi.mock("../src/keychain.js");
vi.mock("../src/repository.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/repository.js")>();
  return {
    ...actual,
    detectRepositoryType: vi.fn(actual.detectRepositoryType),
  };
});

import { loadConfig, loadProjectToolNamesSync } from "../src/config.js";
import factory from "../src/index.js";
import { approvalRegistry, registerArmoryTool, toolRegistry } from "../src/register-tool.js";
import { detectRepositoryType } from "../src/repository.js";
import { registerRequestTool } from "../src/request-tool.js";

const toolA: ArmoryTool = { name: "tool-a", command: "echo a", description: "Tool A" };
const toolB: ArmoryTool = { name: "tool-b", command: "echo b", description: "Tool B" };
const approvalTool: ArmoryTool = {
  name: "dangerous",
  command: "rm -rf {{path}}",
  description: "Dangerous",
  requires_approval: true,
};
const approvalToolNoParams: ArmoryTool = {
  name: "cleanup",
  command: "rm -rf /tmp/cache",
  description: "Cleanup",
  requires_approval: true,
};

// Minimal fake pi context — factory only passes it through to register functions
const fakePi = {
  getActiveTools: () => ["bash", "read", "write", "edit"],
  setActiveTools: vi.fn(),
  on: vi.fn(),
  registerTool: vi.fn(),
  events: { on: vi.fn() },
} as unknown as Parameters<typeof factory>[0];

describe("factory", () => {
  beforeEach(() => {
    vi.mocked(loadConfig).mockResolvedValue({ tools: [], draftModel: undefined, disableBash: true });
    approvalRegistry.clear();
    toolRegistry.clear();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("registers each tool from config via registerArmoryTool", async () => {
    vi.mocked(loadConfig).mockResolvedValue({ tools: [toolA, toolB], draftModel: undefined, disableBash: true });

    await factory(fakePi);

    expect(registerArmoryTool).toHaveBeenCalledTimes(2);
    expect(registerArmoryTool).toHaveBeenCalledWith(fakePi, toolA);
    expect(registerArmoryTool).toHaveBeenCalledWith(fakePi, toolB);
  });

  it("registers request_tool with pi, projectRoot, and draftModel", async () => {
    await factory(fakePi);

    expect(registerRequestTool).toHaveBeenCalledTimes(1);
    expect(registerRequestTool).toHaveBeenCalledWith(fakePi, process.cwd(), undefined);
  });

  it("passes draftModel from config to registerRequestTool", async () => {
    vi.mocked(loadConfig).mockResolvedValue({ tools: [], draftModel: "fast-model", disableBash: true });

    await factory(fakePi);

    expect(registerRequestTool).toHaveBeenCalledWith(fakePi, process.cwd(), "fast-model");
  });

  it("registers no armory tools when config is empty, but still registers request_tool", async () => {
    vi.mocked(loadConfig).mockResolvedValue({ tools: [], draftModel: undefined, disableBash: true });

    await factory(fakePi);

    expect(registerArmoryTool).not.toHaveBeenCalled();
    expect(registerRequestTool).toHaveBeenCalledTimes(1);
  });

  it("propagates errors thrown by loadConfig", async () => {
    vi.mocked(loadConfig).mockRejectedValue(new Error("config read failed"));

    await expect(factory(fakePi)).rejects.toThrow("config read failed");
  });

  describe("session_start active-tool filtering", () => {
    function getSessionStartHandler() {
      // biome-ignore lint/suspicious/noExplicitAny: test helper extracting handler from mock calls
      const call = (fakePi.on as any).mock.calls.find(([event]: [string]) => event === "session_start");
      return call?.[1] as ((event: unknown, ctx: { cwd: string }) => unknown) | undefined;
    }

    const gitTool: ArmoryTool = { name: "git-tool", command: "echo git", description: "Git only", when: "git" };
    const jjTool: ArmoryTool = { name: "jj-tool", command: "echo jj", description: "Jj only", when: "jj" };

    it("registers a session_start handler", async () => {
      vi.mocked(loadConfig).mockResolvedValue({ tools: [], draftModel: undefined, disableBash: true });
      await factory(fakePi);
      expect(getSessionStartHandler()).toBeDefined();
    });

    it("removes bash when disableBash is true", async () => {
      vi.mocked(loadConfig).mockResolvedValue({ tools: [], draftModel: undefined, disableBash: true });
      vi.mocked(detectRepositoryType).mockReturnValue(undefined);
      await factory(fakePi);

      const handler = getSessionStartHandler();
      await handler?.({}, { cwd: "/tmp/proj" });

      expect(fakePi.setActiveTools).toHaveBeenCalledWith(["read", "write", "edit"]);
    });

    it("keeps bash active when disableBash is false", async () => {
      vi.mocked(loadConfig).mockResolvedValue({ tools: [], draftModel: undefined, disableBash: false });
      vi.mocked(detectRepositoryType).mockReturnValue(undefined);
      await factory(fakePi);

      const handler = getSessionStartHandler();
      await handler?.({}, { cwd: "/tmp/proj" });

      expect(fakePi.setActiveTools).toHaveBeenCalledWith(["bash", "read", "write", "edit"]);
    });

    it("keeps unconditional tools active regardless of repository type", async () => {
      vi.mocked(loadConfig).mockResolvedValue({ tools: [toolA], draftModel: undefined, disableBash: false });
      vi.mocked(detectRepositoryType).mockReturnValue("git");
      const fakePiWithTool = {
        ...fakePi,
        getActiveTools: () => ["bash", "read", "write", "edit", "tool-a"],
        setActiveTools: vi.fn(),
      } as unknown as Parameters<typeof factory>[0];
      await factory(fakePiWithTool);

      // biome-ignore lint/suspicious/noExplicitAny: test helper extracting handler from mock calls
      const call = (fakePiWithTool.on as any).mock.calls.find(([event]: [string]) => event === "session_start");
      const handler = call?.[1] as (event: unknown, ctx: { cwd: string }) => unknown;
      await handler({}, { cwd: "/tmp/proj" });

      expect(fakePiWithTool.setActiveTools).toHaveBeenCalledWith(["bash", "read", "write", "edit", "tool-a"]);
    });

    it("removes a git-conditional tool when the workspace is a jj repository", async () => {
      vi.mocked(loadConfig).mockResolvedValue({ tools: [gitTool, jjTool], draftModel: undefined, disableBash: false });
      vi.mocked(detectRepositoryType).mockReturnValue("jj");
      const fakePiWithTools = {
        ...fakePi,
        getActiveTools: () => ["bash", "read", "write", "edit", "git-tool", "jj-tool"],
        setActiveTools: vi.fn(),
      } as unknown as Parameters<typeof factory>[0];
      await factory(fakePiWithTools);

      // biome-ignore lint/suspicious/noExplicitAny: test helper extracting handler from mock calls
      const call = (fakePiWithTools.on as any).mock.calls.find(([event]: [string]) => event === "session_start");
      const handler = call?.[1] as (event: unknown, ctx: { cwd: string }) => unknown;
      await handler({}, { cwd: "/tmp/proj" });

      expect(fakePiWithTools.setActiveTools).toHaveBeenCalledWith(["bash", "read", "write", "edit", "jj-tool"]);
    });

    it("re-enables a matching conditional tool that is not currently active", async () => {
      vi.mocked(loadConfig).mockResolvedValue({ tools: [gitTool], draftModel: undefined, disableBash: false });
      vi.mocked(detectRepositoryType).mockReturnValue("git");
      const fakePiWithTool = {
        ...fakePi,
        getActiveTools: () => ["bash", "read", "write", "edit"],
        setActiveTools: vi.fn(),
      } as unknown as Parameters<typeof factory>[0];
      await factory(fakePiWithTool);

      // biome-ignore lint/suspicious/noExplicitAny: test helper extracting handler from mock calls
      const call = (fakePiWithTool.on as any).mock.calls.find(([event]: [string]) => event === "session_start");
      const handler = call?.[1] as (event: unknown, ctx: { cwd: string }) => unknown;
      await handler({}, { cwd: "/tmp/proj" });

      expect(fakePiWithTool.setActiveTools).toHaveBeenCalledWith(["bash", "read", "write", "edit", "git-tool"]);
    });

    it("reconciles a runtime-registered conditional tool on a later session_start, not just the factory's initial tools", async () => {
      vi.mocked(loadConfig).mockResolvedValue({ tools: [], draftModel: undefined, disableBash: false });
      vi.mocked(detectRepositoryType).mockReturnValue("jj");
      const fakePiWithTool = {
        ...fakePi,
        getActiveTools: () => ["bash", "read", "write", "edit"],
        setActiveTools: vi.fn(),
      };

      await factory(fakePiWithTool);

      // Simulate a runtime registration (e.g. via /armory edit, request_tool, or session tool)
      // that happens after factory setup but before a later session_start event.
      registerArmoryTool(fakePiWithTool as never, jjTool);

      // biome-ignore lint/suspicious/noExplicitAny: test helper extracting handler from mock calls
      const call = (fakePiWithTool.on as any).mock.calls.find(([event]: [string]) => event === "session_start");
      const handler = call?.[1] as (event: unknown, ctx: { cwd: string }) => unknown;
      await handler({}, { cwd: "/tmp/proj" });

      expect(fakePiWithTool.setActiveTools).toHaveBeenCalledWith(["bash", "read", "write", "edit", "jj-tool"]);
    });

    it("treats a failed repository probe as a non-match, removing conditional tools without failing", async () => {
      vi.mocked(loadConfig).mockResolvedValue({ tools: [gitTool, jjTool], draftModel: undefined, disableBash: false });
      vi.mocked(detectRepositoryType).mockReturnValue(undefined);
      const fakePiWithTools = {
        ...fakePi,
        getActiveTools: () => ["bash", "read", "write", "edit", "git-tool", "jj-tool"],
        setActiveTools: vi.fn(),
      } as unknown as Parameters<typeof factory>[0];
      await expect(factory(fakePiWithTools)).resolves.not.toThrow();

      // biome-ignore lint/suspicious/noExplicitAny: test helper extracting handler from mock calls
      const call = (fakePiWithTools.on as any).mock.calls.find(([event]: [string]) => event === "session_start");
      const handler = call?.[1] as (event: unknown, ctx: { cwd: string }) => unknown;
      await expect(handler({}, { cwd: "/tmp/proj" })).resolves.not.toThrow();

      expect(fakePiWithTools.setActiveTools).toHaveBeenCalledWith(["bash", "read", "write", "edit"]);
    });
  });

  describe("tool_call approval handler", () => {
    function getToolCallHandler() {
      // biome-ignore lint/suspicious/noExplicitAny: test helper extracting handler from mock calls
      const call = (fakePi.on as any).mock.calls.find(([event]: [string]) => event === "tool_call");
      return call?.[1] as
        | ((event: { toolName: string; input: Record<string, unknown> }, ctx: unknown) => unknown)
        | undefined;
    }

    it("registers a tool_call handler", async () => {
      vi.mocked(loadConfig).mockResolvedValue({ tools: [approvalTool], draftModel: undefined, disableBash: false });

      await factory(fakePi);

      expect(getToolCallHandler()).toBeDefined();
    });

    it("does not block tools without requires_approval", async () => {
      vi.mocked(loadConfig).mockResolvedValue({ tools: [toolA], draftModel: undefined, disableBash: false });
      await factory(fakePi);

      const handler = getToolCallHandler();
      expect(handler).toBeDefined();
      const ctx = { ui: { confirm: vi.fn() } };
      const result = await handler?.({ toolName: "tool-a", input: {} }, ctx);

      expect(ctx.ui.confirm).not.toHaveBeenCalled();
      expect(result).toBeUndefined();
    });

    it("shows approval panel and allows execution when user runs", async () => {
      vi.mocked(loadConfig).mockResolvedValue({ tools: [approvalTool], draftModel: undefined, disableBash: false });
      await factory(fakePi);

      const handler = getToolCallHandler();
      expect(handler).toBeDefined();
      const customMock = vi.fn().mockResolvedValue("run");
      const ctx = { mode: "tui", hasUI: true, ui: { custom: customMock } };
      const event = { toolName: "dangerous", input: { path: "/tmp" } };
      const result = await handler?.(event, ctx);

      expect(customMock).toHaveBeenCalledOnce();
      expect(result).toBeUndefined();
    });

    it("passes the command template (not interpolated) and parameters to the approval panel, without duplication", async () => {
      vi.mocked(loadConfig).mockResolvedValue({ tools: [approvalTool], draftModel: undefined, disableBash: false });
      await factory(fakePi);

      const handler = getToolCallHandler();
      expect(handler).toBeDefined();

      const distinctivePath = "/very/distinctive/unlikely-value-marker";
      const customMock = vi.fn().mockResolvedValue("run");
      const ctx = { mode: "tui", hasUI: true, ui: { custom: customMock } };
      const event = { toolName: "dangerous", input: { path: distinctivePath } };
      await handler?.(event, ctx);

      expect(customMock).toHaveBeenCalledOnce();
      const panelFactory = customMock.mock.calls[0][0] as (
        tui: TUI,
        theme: Theme,
        kb: unknown,
        done: (action: string) => void,
        // biome-ignore lint/suspicious/noExplicitAny: test helper matching ctx.ui.custom's factory signature
      ) => any;
      const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
      const tui = { requestRender: vi.fn() } as unknown as TUI;
      const panel = panelFactory(tui, plainTheme, undefined, vi.fn());
      const rendered = panel.render(120).join("\n");

      expect(rendered).toContain("dangerous");
      expect(rendered).toContain("rm -rf {{path}}");
      expect(rendered).toContain(distinctivePath);
      const occurrences = rendered.split(distinctivePath).length - 1;
      expect(occurrences).toBe(1);
    });

    it("blocks execution when user rejects", async () => {
      vi.mocked(loadConfig).mockResolvedValue({ tools: [approvalTool], draftModel: undefined, disableBash: false });
      await factory(fakePi);

      const handler = getToolCallHandler();
      expect(handler).toBeDefined();
      const customMock = vi.fn().mockResolvedValue("reject");
      const ctx = { mode: "tui", hasUI: true, ui: { custom: customMock } };
      const result = await handler?.({ toolName: "dangerous", input: { path: "/tmp" } }, ctx);

      expect(result).toEqual({ block: true, reason: expect.stringContaining("rejected") });
    });

    it("rejects fail-closed when the panel is dismissed (undefined)", async () => {
      vi.mocked(loadConfig).mockResolvedValue({ tools: [approvalTool], draftModel: undefined, disableBash: false });
      await factory(fakePi);

      const handler = getToolCallHandler();
      const customMock = vi.fn().mockResolvedValue(undefined);
      const ctx = { mode: "tui", hasUI: true, ui: { custom: customMock } };
      const result = await handler?.({ toolName: "dangerous", input: { path: "/tmp" } }, ctx);

      expect(result).toEqual({ block: true, reason: expect.stringContaining("rejected") });
    });

    it("rejects fail-closed on unexpected panel result values", async () => {
      vi.mocked(loadConfig).mockResolvedValue({ tools: [approvalTool], draftModel: undefined, disableBash: false });
      await factory(fakePi);

      const handler = getToolCallHandler();
      const customMock = vi.fn().mockResolvedValue("???");
      const ctx = { mode: "tui", hasUI: true, ui: { custom: customMock } };
      const result = await handler?.({ toolName: "dangerous", input: { path: "/tmp" } }, ctx);

      expect(result).toEqual({ block: true, reason: expect.stringContaining("rejected") });
    });

    it("loops through a valid edit, mutates event.input, and re-reviews before run", async () => {
      vi.mocked(loadConfig).mockResolvedValue({ tools: [approvalTool], draftModel: undefined, disableBash: false });
      await factory(fakePi);

      const handler = getToolCallHandler();
      const customMock = vi.fn().mockResolvedValueOnce("edit").mockResolvedValueOnce("run");
      const editorMock = vi.fn().mockResolvedValue(JSON.stringify({ path: "/edited" }));
      const notifyMock = vi.fn();
      const ctx = { mode: "tui", hasUI: true, ui: { custom: customMock, editor: editorMock, notify: notifyMock } };
      const event = { toolName: "dangerous", input: { path: "/tmp" } };
      const result = await handler?.(event, ctx);

      expect(customMock).toHaveBeenCalledTimes(2);
      expect(editorMock).toHaveBeenCalledOnce();
      expect(notifyMock).not.toHaveBeenCalled();
      expect(event.input).toEqual({ path: "/edited" });
      // Second review shows the reinterpolated command with the edited param
      expect(customMock.mock.calls[1]).toBeDefined();
      expect(result).toBeUndefined();
    });

    it("notifies and retries on invalid edit JSON, then cancels back to review", async () => {
      vi.mocked(loadConfig).mockResolvedValue({ tools: [approvalTool], draftModel: undefined, disableBash: false });
      await factory(fakePi);

      const handler = getToolCallHandler();
      const customMock = vi.fn().mockResolvedValueOnce("edit").mockResolvedValueOnce("reject");
      const editorMock = vi.fn().mockResolvedValueOnce("{ not json").mockResolvedValueOnce(undefined);
      const notifyMock = vi.fn();
      const ctx = { mode: "tui", hasUI: true, ui: { custom: customMock, editor: editorMock, notify: notifyMock } };
      const event = { toolName: "dangerous", input: { path: "/tmp" } };
      const result = await handler?.(event, ctx);

      expect(notifyMock).toHaveBeenCalledWith(expect.stringContaining("Invalid JSON"), "error");
      expect(editorMock).toHaveBeenCalledTimes(2);
      expect(event.input).toEqual({ path: "/tmp" }); // cancel left input unchanged
      expect(result).toEqual({ block: true, reason: expect.stringContaining("rejected") });
    });

    it("offers the edit hint when the command has parameters", async () => {
      vi.mocked(loadConfig).mockResolvedValue({ tools: [approvalTool], draftModel: undefined, disableBash: false });
      await factory(fakePi);

      const handler = getToolCallHandler();
      const customMock = vi.fn().mockResolvedValue("run");
      const ctx = { mode: "tui", hasUI: true, ui: { custom: customMock } };
      await handler?.({ toolName: "dangerous", input: { path: "/tmp" } }, ctx);

      expect(customMock).toHaveBeenCalledOnce();
      const factoryArg = customMock.mock.calls[0][0];
      const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
      const panel = factoryArg({ requestRender: vi.fn() }, plainTheme, {}, vi.fn());
      expect(panel.render(80).join("\n")).toContain("e edit");
    });

    it("does not offer the edit hint for parameterless approval tools", async () => {
      vi.mocked(loadConfig).mockResolvedValue({
        tools: [approvalToolNoParams],
        draftModel: undefined,
        disableBash: false,
      });
      await factory(fakePi);

      const handler = getToolCallHandler();
      const customMock = vi.fn().mockResolvedValue("run");
      const ctx = { mode: "tui", hasUI: true, ui: { custom: customMock } };
      await handler?.({ toolName: "cleanup", input: {} }, ctx);

      expect(customMock).toHaveBeenCalledOnce();
      const factoryArg = customMock.mock.calls[0][0];
      const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
      const panel = factoryArg({ requestRender: vi.fn() }, plainTheme, {}, vi.fn());
      expect(panel.render(80).join("\n")).not.toContain("e edit");
    });

    it("blocks approval-required calls when there is no UI", async () => {
      vi.mocked(loadConfig).mockResolvedValue({ tools: [approvalTool], draftModel: undefined, disableBash: false });
      await factory(fakePi);

      const handler = getToolCallHandler();
      const customMock = vi.fn();
      const ctx = { mode: "tui", hasUI: false, ui: { custom: customMock } };
      const result = await handler?.({ toolName: "dangerous", input: { path: "/tmp" } }, ctx);

      expect(customMock).not.toHaveBeenCalled();
      expect(result).toEqual({ block: true, reason: expect.stringContaining("no UI is available") });
    });

    it("blocks and does not open approval UI when initial input fails schema validation", async () => {
      vi.mocked(loadConfig).mockResolvedValue({ tools: [approvalTool], draftModel: undefined, disableBash: false });
      await factory(fakePi);

      const handler = getToolCallHandler();
      const customMock = vi.fn();
      const ctx = { mode: "tui", hasUI: true, ui: { custom: customMock } };
      const result = await handler?.({ toolName: "dangerous", input: {} }, ctx);

      expect(customMock).not.toHaveBeenCalled();
      expect(result).toEqual({
        block: true,
        reason: expect.stringContaining("Invalid parameters"),
      });
    });

    it("blocks approval-required calls in RPC mode even when hasUI is true, without opening any UI primitive", async () => {
      vi.mocked(loadConfig).mockResolvedValue({ tools: [approvalTool], draftModel: undefined, disableBash: false });
      await factory(fakePi);

      const handler = getToolCallHandler();
      expect(handler).toBeDefined();
      const customMock = vi.fn();
      const editorMock = vi.fn();
      const ctx = { mode: "rpc", hasUI: true, ui: { custom: customMock, editor: editorMock } };
      const event = { toolName: "dangerous", input: { path: "/tmp" } };
      const result = await handler?.(event, ctx);

      expect(customMock).not.toHaveBeenCalled();
      expect(editorMock).not.toHaveBeenCalled();
      expect(result).toEqual({
        block: true,
        reason: expect.stringContaining("interactive TUI"),
      });
    });

    it("includes runtime-registered tools in approval checks", async () => {
      vi.mocked(loadConfig).mockResolvedValue({ tools: [], draftModel: undefined, disableBash: false });
      await factory(fakePi);

      // Simulate runtime registration (e.g., via request_tool)
      approvalRegistry.set("new-tool", {
        name: "new-tool",
        command: "deploy",
        description: "Deploy",
        requires_approval: true,
      });

      const handler = getToolCallHandler();
      expect(handler).toBeDefined();
      const customMock = vi.fn().mockResolvedValue("reject");
      const ctx = { mode: "tui", hasUI: true, ui: { custom: customMock } };
      const result = await handler?.({ toolName: "new-tool", input: {} }, ctx);

      expect(customMock).toHaveBeenCalledOnce();
      expect(result).toEqual({ block: true, reason: expect.stringContaining("rejected") });
    });
  });

  describe("pi-armory:project-tools:v1 listener", () => {
    function getProjectToolsHandler() {
      // biome-ignore lint/suspicious/noExplicitAny: test helper extracting handler from mock calls
      const call = (fakePi.events.on as any).mock.calls.find(
        ([event]: [string]) => event === "pi-armory:project-tools:v1",
      );
      return call?.[1] as ((payload: unknown) => void) | undefined;
    }

    it("registers a listener via pi.events.on", async () => {
      await factory(fakePi);
      expect(getProjectToolsHandler()).toBeDefined();
    });

    it("responds exactly once with current project tool names", async () => {
      vi.mocked(loadProjectToolNamesSync).mockReturnValue(["tool-a", "tool-b"]);
      await factory(fakePi);

      const handler = getProjectToolsHandler();
      const respond = vi.fn();
      handler?.({ respond });

      expect(loadProjectToolNamesSync).toHaveBeenCalledWith(process.cwd());
      expect(respond).toHaveBeenCalledTimes(1);
      expect(respond).toHaveBeenCalledWith(["tool-a", "tool-b"]);
    });

    it("queries fresh project config on every request", async () => {
      await factory(fakePi);
      const handler = getProjectToolsHandler();

      vi.mocked(loadProjectToolNamesSync).mockReturnValue(["tool-a"]);
      const respond1 = vi.fn();
      handler?.({ respond: respond1 });
      expect(respond1).toHaveBeenCalledWith(["tool-a"]);

      vi.mocked(loadProjectToolNamesSync).mockReturnValue(["tool-a", "tool-b"]);
      const respond2 = vi.fn();
      handler?.({ respond: respond2 });
      expect(respond2).toHaveBeenCalledWith(["tool-a", "tool-b"]);
    });

    it("ignores malformed payloads without throwing", async () => {
      await factory(fakePi);
      const handler = getProjectToolsHandler();

      expect(() => handler?.(undefined)).not.toThrow();
      expect(() => handler?.(null)).not.toThrow();
      expect(() => handler?.({})).not.toThrow();
      expect(() => handler?.({ respond: "not-a-function" })).not.toThrow();
      expect(() => handler?.("string")).not.toThrow();
    });
  });
});
