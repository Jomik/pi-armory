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

import { loadConfig } from "../src/config.js";
import factory from "../src/index.js";
import { approvalRegistry, registerArmoryTool } from "../src/register-tool.js";
import { registerRequestTool } from "../src/request-tool.js";

const toolA: ArmoryTool = { name: "tool-a", command: "echo a", description: "Tool A" };
const toolB: ArmoryTool = { name: "tool-b", command: "echo b", description: "Tool B" };
const approvalTool: ArmoryTool = {
  name: "dangerous",
  command: "rm -rf {{path}}",
  description: "Dangerous",
  requires_approval: true,
};

// Minimal fake pi context — factory only passes it through to register functions
const fakePi = {
  getActiveTools: () => ["bash", "read", "write", "edit"],
  setActiveTools: vi.fn(),
  on: vi.fn(),
  registerTool: vi.fn(),
} as unknown as Parameters<typeof factory>[0];

describe("factory", () => {
  beforeEach(() => {
    vi.mocked(loadConfig).mockResolvedValue({ tools: [], draftModel: undefined, disableBash: true });
    approvalRegistry.clear();
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

    it("shows approval panel and allows execution when user approves", async () => {
      vi.mocked(loadConfig).mockResolvedValue({ tools: [approvalTool], draftModel: undefined, disableBash: false });
      await factory(fakePi);

      const handler = getToolCallHandler();
      expect(handler).toBeDefined();
      const customMock = vi.fn().mockResolvedValue(true);
      const ctx = { ui: { custom: customMock } };
      const result = await handler?.({ toolName: "dangerous", input: { path: "/tmp" } }, ctx);

      expect(customMock).toHaveBeenCalledOnce();
      expect(result).toBeUndefined();
    });

    it("blocks execution when user rejects", async () => {
      vi.mocked(loadConfig).mockResolvedValue({ tools: [approvalTool], draftModel: undefined, disableBash: false });
      await factory(fakePi);

      const handler = getToolCallHandler();
      expect(handler).toBeDefined();
      const customMock = vi.fn().mockResolvedValue(false);
      const ctx = { ui: { custom: customMock } };
      const result = await handler?.({ toolName: "dangerous", input: { path: "/tmp" } }, ctx);

      expect(result).toEqual({ block: true, reason: expect.stringContaining("rejected") });
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
      const customMock = vi.fn().mockResolvedValue(false);
      const ctx = { ui: { custom: customMock } };
      const result = await handler?.({ toolName: "new-tool", input: {} }, ctx);

      expect(customMock).toHaveBeenCalledOnce();
      expect(result).toEqual({ block: true, reason: expect.stringContaining("rejected") });
    });
  });
});
