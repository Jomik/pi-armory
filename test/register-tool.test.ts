import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ArmoryTool } from "../src/config.js";
import { executeCommand } from "../src/executor.js";
import { fetchSecret } from "../src/keychain.js";
import { registerArmoryTool } from "../src/register-tool.js";

vi.mock("../src/executor.js");
vi.mock("../src/keychain.js");

const mockExecuteCommand = vi.mocked(executeCommand);
const mockFetchSecret = vi.mocked(fetchSecret);

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
    mockFetchSecret.mockReset();
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

  it("does not prompt in execute when requires_approval=true (approval handled by tool_call event)", async () => {
    mockExecuteCommand.mockResolvedValue("done");
    const execute = registerAndCapture(approvalTool);
    const ctx = makeCtx(true);

    const result = await execute("call-1", {}, new AbortController().signal, undefined, ctx);

    expect(ctx.ui.confirm).not.toHaveBeenCalled();
    expect(mockExecuteCommand).toHaveBeenCalledOnce();
    expect(result.content[0].text).toBe("done");
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

  describe("secrets", () => {
    const secretTool: ArmoryTool = {
      name: "secret-tool",
      command: "deploy",
      description: "Deploy with secrets",
      secrets: { API_KEY: "api-key-account", DB_PASS: "db-pass-account" },
    };

    it("fetches secrets from keychain and passes them as extraEnv", async () => {
      mockFetchSecret.mockImplementation(async (account) => `value-for-${account}`);
      mockExecuteCommand.mockResolvedValue("ok");
      const execute = registerAndCapture(secretTool);

      await execute("call-1", {}, new AbortController().signal, undefined, makeCtx());

      expect(mockFetchSecret).toHaveBeenCalledWith("api-key-account");
      expect(mockFetchSecret).toHaveBeenCalledWith("db-pass-account");

      const opts = mockExecuteCommand.mock.calls[0][1];
      expect(opts?.extraEnv).toEqual({
        API_KEY: "value-for-api-key-account",
        DB_PASS: "value-for-db-pass-account",
      });
    });

    it("passes fetched secret values as redact array", async () => {
      mockFetchSecret.mockImplementation(async (account) => `value-for-${account}`);
      mockExecuteCommand.mockResolvedValue("ok");
      const execute = registerAndCapture(secretTool);

      await execute("call-1", {}, new AbortController().signal, undefined, makeCtx());

      const opts = mockExecuteCommand.mock.calls[0][1];
      expect(opts?.redact).toContain("value-for-api-key-account");
      expect(opts?.redact).toContain("value-for-db-pass-account");
    });

    it("does not call fetchSecret when tool has no secrets", async () => {
      mockExecuteCommand.mockResolvedValue("ok");
      const execute = registerAndCapture(baseTool);

      await execute("call-1", {}, new AbortController().signal, undefined, makeCtx());

      expect(mockFetchSecret).not.toHaveBeenCalled();
      const opts = mockExecuteCommand.mock.calls[0][1];
      expect(opts?.extraEnv).toBeUndefined();
      expect(opts?.redact).toBeUndefined();
    });

    it("does not call fetchSecret when secrets is empty object", async () => {
      const toolWithEmptySecrets: ArmoryTool = {
        name: "no-secrets-tool",
        command: "echo hi",
        description: "No secrets",
        secrets: {},
      };
      mockExecuteCommand.mockResolvedValue("ok");
      const execute = registerAndCapture(toolWithEmptySecrets);

      await execute("call-1", {}, new AbortController().signal, undefined, makeCtx());

      expect(mockFetchSecret).not.toHaveBeenCalled();
    });

    it("propagates errors thrown by fetchSecret", async () => {
      mockFetchSecret.mockRejectedValue(new Error("keychain locked"));
      const execute = registerAndCapture(secretTool);

      await expect(execute("call-1", {}, new AbortController().signal, undefined, makeCtx())).rejects.toThrow(
        "keychain locked",
      );
    });
  });

  describe("env", () => {
    const envTool: ArmoryTool = {
      name: "env-tool",
      command: "deploy",
      description: "Deploy with env",
      env: { JIRA_SERVER: "https://jira.example.com", FORWARD: "$ARMORY_TEST_FWD" },
    };

    it("passes static env values as extraEnv", async () => {
      mockExecuteCommand.mockResolvedValue("ok");
      const execute = registerAndCapture({
        name: "static-env",
        command: "echo hi",
        description: "test",
        env: { SERVER: "https://example.com" },
      });

      await execute("call-1", {}, new AbortController().signal, undefined, makeCtx());

      const opts = mockExecuteCommand.mock.calls[0][1];
      expect(opts?.extraEnv).toEqual({ SERVER: "https://example.com" });
    });

    it("resolves $VAR references from process.env", async () => {
      process.env.ARMORY_TEST_FWD = "forwarded-value";
      mockExecuteCommand.mockResolvedValue("ok");
      const execute = registerAndCapture(envTool);

      await execute("call-1", {}, new AbortController().signal, undefined, makeCtx());

      const opts = mockExecuteCommand.mock.calls[0][1];
      expect(opts?.extraEnv).toEqual({
        JIRA_SERVER: "https://jira.example.com",
        FORWARD: "forwarded-value",
      });
      delete process.env.ARMORY_TEST_FWD;
    });

    it("throws when a $VAR reference is not set in process.env", async () => {
      delete process.env.ARMORY_TEST_FWD;
      mockExecuteCommand.mockResolvedValue("ok");
      const execute = registerAndCapture(envTool);

      await expect(execute("call-1", {}, new AbortController().signal, undefined, makeCtx())).rejects.toThrow(
        /Environment variable 'ARMORY_TEST_FWD' \(referenced by env\.FORWARD\) is not set/,
      );
    });

    it("does not redact env values", async () => {
      process.env.ARMORY_TEST_FWD = "forwarded-value";
      mockExecuteCommand.mockResolvedValue("ok");
      const execute = registerAndCapture(envTool);

      await execute("call-1", {}, new AbortController().signal, undefined, makeCtx());

      const opts = mockExecuteCommand.mock.calls[0][1];
      expect(opts?.redact).toBeUndefined();
      delete process.env.ARMORY_TEST_FWD;
    });

    it("does not set extraEnv when env is empty object", async () => {
      mockExecuteCommand.mockResolvedValue("ok");
      const execute = registerAndCapture({
        name: "empty-env",
        command: "echo hi",
        description: "test",
        env: {},
      });

      await execute("call-1", {}, new AbortController().signal, undefined, makeCtx());

      const opts = mockExecuteCommand.mock.calls[0][1];
      expect(opts?.extraEnv).toBeUndefined();
    });

    it("escapes $$ to a literal dollar sign", async () => {
      mockExecuteCommand.mockResolvedValue("ok");
      const execute = registerAndCapture({
        name: "escape-tool",
        command: "echo hi",
        description: "test",
        env: { PRICE: "$$9.99", PREFIX: "$$HOME/local" },
      });

      await execute("call-1", {}, new AbortController().signal, undefined, makeCtx());

      const opts = mockExecuteCommand.mock.calls[0][1];
      expect(opts?.extraEnv).toEqual({ PRICE: "$9.99", PREFIX: "$HOME/local" });
    });

    it("skips env keys that secrets also define (secrets win)", async () => {
      mockFetchSecret.mockImplementation(async (account) => `secret-${account}`);
      mockExecuteCommand.mockResolvedValue("ok");
      const execute = registerAndCapture({
        name: "overlap-tool",
        command: "deploy",
        description: "test",
        env: { SERVER: "https://example.com", TOKEN: "$NONEXISTENT_VAR" },
        secrets: { TOKEN: "token-account" },
      });

      // Should NOT throw despite $NONEXISTENT_VAR being unset,
      // because TOKEN is skipped (secrets take precedence)
      await execute("call-1", {}, new AbortController().signal, undefined, makeCtx());

      const opts = mockExecuteCommand.mock.calls[0][1];
      expect(opts?.extraEnv).toEqual({
        SERVER: "https://example.com",
        TOKEN: "secret-token-account",
      });
      expect(opts?.redact).toContain("secret-token-account");
    });

    it("merges env and secrets into extraEnv with secrets winning on conflict", async () => {
      mockFetchSecret.mockImplementation(async (account) => `secret-${account}`);
      mockExecuteCommand.mockResolvedValue("ok");
      const execute = registerAndCapture({
        name: "both-tool",
        command: "deploy",
        description: "test",
        env: { SERVER: "https://example.com", TOKEN: "overridden" },
        secrets: { TOKEN: "token-account" },
      });

      await execute("call-1", {}, new AbortController().signal, undefined, makeCtx());

      const opts = mockExecuteCommand.mock.calls[0][1];
      expect(opts?.extraEnv).toEqual({
        SERVER: "https://example.com",
        TOKEN: "secret-token-account",
      });
      expect(opts?.redact).toContain("secret-token-account");
    });
  });
});
