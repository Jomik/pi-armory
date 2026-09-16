import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ArmoryTool } from "../src/config.js";
import { executeCommand } from "../src/executor.js";
import { approvalRegistry, registerArmoryTool, toolRegistry } from "../src/register-tool.js";

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
    approvalRegistry.clear();
    toolRegistry.clear();
  });

  it("calls pi.registerTool with the correct name and description", () => {
    const registerTool = vi.fn();
    registerArmoryTool({ registerTool } as unknown as ExtensionAPI, baseTool);

    expect(registerTool).toHaveBeenCalledOnce();
    const def = registerTool.mock.calls[0][0];
    expect(def.name).toBe("my-tool");
    expect(def.description).toBe("A test tool");
  });

  it("tells agents to call approval tools directly", () => {
    const registerTool = vi.fn();
    registerArmoryTool({ registerTool } as unknown as ExtensionAPI, { ...approvalTool, guidelines: ["Use caution"] });

    expect(registerTool.mock.calls[0][0].promptGuidelines).toEqual([
      "This tool prompts the user for approval when called. Call it directly; do not ask for approval first.",
      "Use caution",
    ]);
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

  it("does not prompt in execute when requires_approval=true (approval handled by tool_call event)", async () => {
    mockExecuteCommand.mockResolvedValue("done");
    const execute = registerAndCapture(approvalTool);
    const ctx = makeCtx(true);

    const result = await execute("call-1", {}, new AbortController().signal, undefined, ctx);

    expect(ctx.ui.confirm).not.toHaveBeenCalled();
    expect(mockExecuteCommand).toHaveBeenCalledOnce();
    expect(result.content[0].text).toBe("done");
  });

  it("clears stale approval entries when re-registering a non-approval tool", () => {
    registerArmoryTool({ registerTool: vi.fn() } as unknown as ExtensionAPI, approvalTool);
    expect(approvalRegistry.has("approval-tool")).toBe(true);

    registerArmoryTool({ registerTool: vi.fn() } as unknown as ExtensionAPI, {
      ...approvalTool,
      requires_approval: false,
    });

    expect(approvalRegistry.has("approval-tool")).toBe(false);
  });

  it("tracks the latest effective definition for a tool name in toolRegistry", () => {
    registerArmoryTool({ registerTool: vi.fn() } as unknown as ExtensionAPI, baseTool);
    expect(toolRegistry.get("my-tool")).toEqual(baseTool);

    const updated = { ...baseTool, command: "echo updated" };
    registerArmoryTool({ registerTool: vi.fn() } as unknown as ExtensionAPI, updated);
    expect(toolRegistry.get("my-tool")).toEqual(updated);
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

  describe("env", () => {
    /**
     * Distinguishes resolver-command invocations from the tool's main command by
     * matching on the command string passed to executeCommand.
     */
    function mockResolverAndMain(resolvers: Record<string, string | Error>, mainOutput = "main-ok") {
      mockExecuteCommand.mockImplementation(async (cmd) => {
        if (Object.hasOwn(resolvers, cmd)) {
          const result = resolvers[cmd];
          if (result instanceof Error) throw result;
          return result;
        }
        return mainOutput;
      });
    }

    it("passes a string literal verbatim and does not redact it", async () => {
      mockExecuteCommand.mockResolvedValue("ok");
      const execute = registerAndCapture({
        name: "literal-tool",
        command: "echo hi",
        description: "test",
        env: { SERVER: "https://example.com" },
      });

      await execute("call-1", {}, new AbortController().signal, undefined, makeCtx());

      const opts = mockExecuteCommand.mock.calls[0][1];
      expect(opts?.extraEnv).toEqual({ SERVER: "https://example.com" });
      expect(opts?.redact).toBeUndefined();
    });

    it("resolves { env } bindings from process.env", async () => {
      process.env.ARMORY_TEST_FWD = "forwarded-value";
      mockExecuteCommand.mockResolvedValue("ok");
      const execute = registerAndCapture({
        name: "host-env-tool",
        command: "echo hi",
        description: "test",
        env: { FORWARD: { env: "ARMORY_TEST_FWD" } },
      });

      await execute("call-1", {}, new AbortController().signal, undefined, makeCtx());

      const opts = mockExecuteCommand.mock.calls[0][1];
      expect(opts?.extraEnv).toEqual({ FORWARD: "forwarded-value" });
      delete process.env.ARMORY_TEST_FWD;
    });

    it("throws a clear error when a { env } binding is absent from process.env", async () => {
      delete process.env.ARMORY_TEST_FWD;
      const execute = registerAndCapture({
        name: "missing-host-env-tool",
        command: "echo hi",
        description: "test",
        env: { FORWARD: { env: "ARMORY_TEST_FWD" } },
      });

      await expect(execute("call-1", {}, new AbortController().signal, undefined, makeCtx())).rejects.toThrow(
        /Environment variable 'ARMORY_TEST_FWD' \(referenced by env\.FORWARD\) is not set/,
      );
      expect(mockExecuteCommand).not.toHaveBeenCalled();
    });

    it("resolves { command } bindings using the tool's cwd and abort signal, trimming stdout", async () => {
      mockResolverAndMain({ "print-token": "  resolved-token  \n" });
      const execute = registerAndCapture({
        name: "command-tool",
        command: "echo hi",
        description: "test",
        env: { TOKEN: { command: "print-token" } },
      });
      const { signal } = new AbortController();

      await execute("call-1", {}, signal, undefined, makeCtx());

      expect(mockExecuteCommand).toHaveBeenCalledWith(
        "print-token",
        expect.objectContaining({ cwd: "/test/cwd", signal }),
      );
      const resolverOpts = mockExecuteCommand.mock.calls[0][1];
      expect(resolverOpts?.onUpdate).toBeUndefined();
      expect(resolverOpts?.extraEnv).toBeUndefined();
      expect(resolverOpts?.stdoutOnly).toBe(true);

      const mainOpts = mockExecuteCommand.mock.calls[1][1];
      expect(mainOpts?.extraEnv).toEqual({ TOKEN: "resolved-token" });
      expect(mainOpts?.stdoutOnly).toBeUndefined();
    });

    it("throws when a { command } binding produces empty (or whitespace-only) output", async () => {
      mockResolverAndMain({ "print-token": "   \n" });
      const execute = registerAndCapture({
        name: "empty-output-tool",
        command: "echo hi",
        description: "test",
        env: { TOKEN: { command: "print-token" } },
      });

      await expect(execute("call-1", {}, new AbortController().signal, undefined, makeCtx())).rejects.toThrow(
        /produced no output/,
      );
    });

    it("prevents the main command from running when a resolver fails", async () => {
      mockResolverAndMain({ "print-token": new Error("boom") });
      const execute = registerAndCapture({
        name: "failing-resolver-tool",
        command: "echo hi",
        description: "test",
        env: { TOKEN: { command: "print-token" } },
      });

      await expect(execute("call-1", {}, new AbortController().signal, undefined, makeCtx())).rejects.toThrow();

      expect(mockExecuteCommand).toHaveBeenCalledOnce();
      expect(mockExecuteCommand).toHaveBeenCalledWith("print-token", expect.anything());
    });

    it("suppresses resolver stdout/stderr/error text when a secret binding's command fails", async () => {
      mockResolverAndMain({
        "print-secret": new Error("leaked-secret-detail: sk-super-sensitive-value"),
      });
      const execute = registerAndCapture({
        name: "secret-failure-tool",
        command: "echo hi",
        description: "test",
        env: { TOKEN: { command: "print-secret", secret: true } },
      });

      let caught: unknown;
      try {
        await execute("call-1", {}, new AbortController().signal, undefined, makeCtx());
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      const message = (caught as Error).message;
      expect(message).toContain("env.TOKEN");
      expect(message).not.toContain("sk-super-sensitive-value");
      expect(message).not.toContain("leaked-secret-detail");
    });

    it("retains useful error context when a non-secret binding's command fails", async () => {
      mockResolverAndMain({ "print-token": new Error("boom: exit code 1") });
      const execute = registerAndCapture({
        name: "non-secret-failure-tool",
        command: "echo hi",
        description: "test",
        env: { TOKEN: { command: "print-token" } },
      });

      await expect(execute("call-1", {}, new AbortController().signal, undefined, makeCtx())).rejects.toThrow(
        /boom: exit code 1/,
      );
    });

    it("redacts a secret { env } binding's resolved value from the main command", async () => {
      process.env.ARMORY_TEST_SECRET = "super-secret-value";
      mockExecuteCommand.mockResolvedValue("ok");
      const execute = registerAndCapture({
        name: "secret-host-env-tool",
        command: "echo hi",
        description: "test",
        env: { TOKEN: { env: "ARMORY_TEST_SECRET", secret: true } },
      });

      await execute("call-1", {}, new AbortController().signal, undefined, makeCtx());

      const opts = mockExecuteCommand.mock.calls[0][1];
      expect(opts?.extraEnv).toEqual({ TOKEN: "super-secret-value" });
      expect(opts?.redact).toEqual(["super-secret-value"]);
      delete process.env.ARMORY_TEST_SECRET;
    });

    it("redacts a secret { command } binding's resolved value from the main command", async () => {
      mockResolverAndMain({ "print-token": "secret-output" });
      const execute = registerAndCapture({
        name: "secret-command-tool",
        command: "echo hi",
        description: "test",
        env: { TOKEN: { command: "print-token", secret: true } },
      });

      await execute("call-1", {}, new AbortController().signal, undefined, makeCtx());

      const mainOpts = mockExecuteCommand.mock.calls[1][1];
      expect(mainOpts?.extraEnv).toEqual({ TOKEN: "secret-output" });
      expect(mainOpts?.redact).toEqual(["secret-output"]);
    });

    it("resolves a mix of literal, host env, and command bindings independently", async () => {
      process.env.ARMORY_TEST_MIXED = "host-value";
      mockResolverAndMain({ "print-token": "command-value" });
      const execute = registerAndCapture({
        name: "mixed-tool",
        command: "echo hi",
        description: "test",
        env: {
          PUBLIC: "literal-value",
          HOST: { env: "ARMORY_TEST_MIXED" },
          SECRET: { command: "print-token", secret: true },
        },
      });

      await execute("call-1", {}, new AbortController().signal, undefined, makeCtx());

      const mainOpts = mockExecuteCommand.mock.calls[1][1];
      expect(mainOpts?.extraEnv).toEqual({
        PUBLIC: "literal-value",
        HOST: "host-value",
        SECRET: "command-value",
      });
      expect(mainOpts?.redact).toEqual(["command-value"]);
      delete process.env.ARMORY_TEST_MIXED;
    });

    it("does not expose resolved bindings to resolver commands via extraEnv", async () => {
      process.env.ARMORY_TEST_MIXED2 = "host-value-2";
      mockResolverAndMain({ "print-token": "command-value-2" });
      const execute = registerAndCapture({
        name: "isolated-resolvers-tool",
        command: "echo hi",
        description: "test",
        env: {
          HOST: { env: "ARMORY_TEST_MIXED2" },
          COMMAND: { command: "print-token" },
        },
      });

      await execute("call-1", {}, new AbortController().signal, undefined, makeCtx());

      const resolverCall = mockExecuteCommand.mock.calls.find(([cmd]) => cmd === "print-token");
      expect(resolverCall?.[1]?.extraEnv).toBeUndefined();
      delete process.env.ARMORY_TEST_MIXED2;
    });

    it("returns no extraEnv/redact when env is absent", async () => {
      mockExecuteCommand.mockResolvedValue("ok");
      const execute = registerAndCapture(baseTool);

      await execute("call-1", {}, new AbortController().signal, undefined, makeCtx());

      const opts = mockExecuteCommand.mock.calls[0][1];
      expect(opts?.extraEnv).toBeUndefined();
      expect(opts?.redact).toBeUndefined();
    });

    it("returns no extraEnv/redact when env is an empty object", async () => {
      mockExecuteCommand.mockResolvedValue("ok");
      const execute = registerAndCapture({
        name: "empty-env-tool",
        command: "echo hi",
        description: "test",
        env: {},
      });

      await execute("call-1", {}, new AbortController().signal, undefined, makeCtx());

      const opts = mockExecuteCommand.mock.calls[0][1];
      expect(opts?.extraEnv).toBeUndefined();
      expect(opts?.redact).toBeUndefined();
    });
  });
});
