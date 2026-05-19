import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ArmoryTool } from "../src/config.js";
import { executeCommand } from "../src/executor.js";
import { registerArmoryTool } from "../src/register-tool.js";

vi.mock("../src/executor.js");

const mockExecuteCommand = vi.mocked(executeCommand);

// Shape of the update object passed to the tool's onUpdate callback
type ToolUpdate = { content: { type: string; text: string }[]; details: undefined };

// Shape of the execute function captured from pi.registerTool
type ExecuteFn = (
  toolCallId: string,
  params: Record<string, unknown>,
  signal: AbortSignal,
  onUpdate: ((update: ToolUpdate) => void) | undefined,
  ctx: { cwd: string; ui: { confirm: (title: string, message: string) => Promise<boolean> } },
) => Promise<ToolUpdate>;

function makeCtx(confirmResult = true) {
  return {
    cwd: "/test/cwd",
    ui: {
      confirm: vi.fn().mockResolvedValue(confirmResult),
    },
  };
}

/**
 * Registers a tool and returns the execute function captured from the pi mock.
 */
function registerAndCapture(tool: ArmoryTool): ExecuteFn {
  let captured: ExecuteFn | undefined;
  const pi = {
    registerTool: vi.fn((def: { execute: ExecuteFn }) => {
      captured = def.execute;
    }),
  } as unknown as ExtensionAPI;
  registerArmoryTool(pi, tool);
  if (!captured) throw new Error("registerTool was not called");
  return captured;
}

const baseTool: ArmoryTool = {
  name: "my-tool",
  command: "echo hello",
  description: "A test tool",
};

const approvalTool: ArmoryTool = {
  name: "approval-tool",
  command: "rm -rf /",
  description: "Dangerous tool",
  requires_approval: true,
};

describe("registerArmoryTool", () => {
  beforeEach(() => {
    mockExecuteCommand.mockReset();
  });

  it("calls pi.registerTool with the correct name and description", () => {
    const registerTool = vi.fn();
    registerArmoryTool({ registerTool } as unknown as ExtensionAPI, baseTool);

    expect(registerTool).toHaveBeenCalledOnce();
    const def = registerTool.mock.calls[0][0];
    expect(def.name).toBe("my-tool");
    expect(def.description).toBe("A test tool");
  });

  it("executes command and returns output on success", async () => {
    mockExecuteCommand.mockResolvedValue("hello\n");
    const execute = registerAndCapture(baseTool);
    const ctx = makeCtx();
    const { signal } = new AbortController();

    const result = await execute("call-1", {}, signal, undefined, ctx);

    expect(mockExecuteCommand).toHaveBeenCalledOnce();
    expect(mockExecuteCommand).toHaveBeenCalledWith(
      "echo hello",
      expect.objectContaining({ cwd: "/test/cwd", signal }),
    );
    expect(result.content[0]).toEqual({ type: "text", text: "hello\n" });
    expect(result.details).toBeUndefined();
  });

  it("returns '(no output)' when command produces empty string", async () => {
    mockExecuteCommand.mockResolvedValue("");
    const execute = registerAndCapture(baseTool);

    const result = await execute("call-1", {}, new AbortController().signal, undefined, makeCtx());

    expect(result.content[0].text).toBe("(no output)");
  });

  it("propagates the error when the command fails", async () => {
    mockExecuteCommand.mockRejectedValue(new Error("Command exited with code 1: oops"));
    const execute = registerAndCapture(baseTool);

    await expect(execute("call-1", {}, new AbortController().signal, undefined, makeCtx())).rejects.toThrow(
      "Command exited with code 1",
    );
  });

  it("does not prompt when requires_approval is not set", async () => {
    mockExecuteCommand.mockResolvedValue("ok");
    const execute = registerAndCapture(baseTool);
    const ctx = makeCtx();

    await execute("call-1", {}, new AbortController().signal, undefined, ctx);

    expect(ctx.ui.confirm).not.toHaveBeenCalled();
    expect(mockExecuteCommand).toHaveBeenCalledOnce();
  });

  it("prompts and runs command when requires_approval=true and user approves", async () => {
    mockExecuteCommand.mockResolvedValue("done");
    const execute = registerAndCapture(approvalTool);
    const ctx = makeCtx(true);

    const result = await execute("call-1", {}, new AbortController().signal, undefined, ctx);

    expect(ctx.ui.confirm).toHaveBeenCalledOnce();
    expect(ctx.ui.confirm).toHaveBeenCalledWith("Run: approval-tool", expect.stringContaining("rm -rf /"));
    expect(mockExecuteCommand).toHaveBeenCalledOnce();
    expect(result.content[0].text).toBe("done");
  });

  it("returns rejection message and skips command when requires_approval=true and user rejects", async () => {
    const execute = registerAndCapture(approvalTool);
    const ctx = makeCtx(false);

    const result = await execute("call-1", {}, new AbortController().signal, undefined, ctx);

    expect(ctx.ui.confirm).toHaveBeenCalledOnce();
    expect(mockExecuteCommand).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("approval-tool");
    expect(result.content[0].text).toContain("rejected");
    expect(result.details).toBeUndefined();
  });

  it("passes an onUpdate wrapper to executeCommand that forwards updates", async () => {
    mockExecuteCommand.mockImplementation(async (_cmd, opts) => {
      opts?.onUpdate?.("partial output");
      return "final output";
    });
    const execute = registerAndCapture(baseTool);
    const onUpdate = vi.fn();

    await execute("call-1", {}, new AbortController().signal, onUpdate, makeCtx());

    expect(onUpdate).toHaveBeenCalledWith({
      content: [{ type: "text", text: "partial output" }],
      details: undefined,
    });
  });

  it("omits onUpdate from executeCommand options when no callback is provided", async () => {
    mockExecuteCommand.mockResolvedValue("result");
    const execute = registerAndCapture(baseTool);

    await execute("call-1", {}, new AbortController().signal, undefined, makeCtx());

    const opts = mockExecuteCommand.mock.calls[0][1];
    expect(opts?.onUpdate).toBeUndefined();
  });
});
