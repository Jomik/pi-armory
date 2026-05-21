import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ArmoryTool } from "../src/config.js";
import { executeCommand } from "../src/executor.js";
import { registerArmoryTool } from "../src/register-tool.js";

vi.mock("../src/executor.js");

const mockExecuteCommand = vi.mocked(executeCommand);

type ToolUpdate = { content: { type: string; text: string }[]; details: undefined };
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
    ui: { confirm: vi.fn().mockResolvedValue(confirmResult) },
  };
}

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

describe("registerArmoryTool — parameter interpolation", () => {
  beforeEach(() => {
    mockExecuteCommand.mockReset();
  });

  it("interpolates a single parameter into the command", async () => {
    mockExecuteCommand.mockResolvedValue("result\n");
    const tool: ArmoryTool = {
      name: "greet",
      command: "echo {{name}}",
      description: "Greet someone",
      parameters: { name: { type: "string", description: "Name to greet" } },
    };
    const execute = registerAndCapture(tool);

    await execute("call-1", { name: "world" }, new AbortController().signal, undefined, makeCtx());

    expect(mockExecuteCommand).toHaveBeenCalledWith("echo 'world'", expect.objectContaining({ cwd: "/test/cwd" }));
  });

  it("interpolates multiple parameters into the command", async () => {
    mockExecuteCommand.mockResolvedValue("ok");
    const tool: ArmoryTool = {
      name: "copy",
      command: "cp {{src}} {{dst}}",
      description: "Copy a file",
      parameters: {
        src: { type: "string", description: "Source path" },
        dst: { type: "string", description: "Destination path" },
      },
    };
    const execute = registerAndCapture(tool);

    await execute("call-1", { src: "/a/b", dst: "/c/d" }, new AbortController().signal, undefined, makeCtx());

    expect(mockExecuteCommand).toHaveBeenCalledWith("cp '/a/b' '/c/d'", expect.objectContaining({}));
  });

  it("shell-escapes a value with spaces", async () => {
    mockExecuteCommand.mockResolvedValue("ok");
    const tool: ArmoryTool = {
      name: "echo-path",
      command: "echo {{path}}",
      description: "Echo a path",
      parameters: { path: { type: "string", description: "A file path" } },
    };
    const execute = registerAndCapture(tool);

    await execute("call-1", { path: "hello world" }, new AbortController().signal, undefined, makeCtx());

    expect(mockExecuteCommand).toHaveBeenCalledWith("echo 'hello world'", expect.objectContaining({}));
  });

  it("shell-escapes a value with single quotes", async () => {
    mockExecuteCommand.mockResolvedValue("ok");
    const tool: ArmoryTool = {
      name: "echo-val",
      command: "echo {{val}}",
      description: "Echo a value",
      parameters: { val: { type: "string", description: "A value" } },
    };
    const execute = registerAndCapture(tool);

    await execute("call-1", { val: "it's alive" }, new AbortController().signal, undefined, makeCtx());

    expect(mockExecuteCommand).toHaveBeenCalledWith("echo 'it'\\''s alive'", expect.objectContaining({}));
  });

  it("shell-escapes a value with semicolons", async () => {
    mockExecuteCommand.mockResolvedValue("ok");
    const tool: ArmoryTool = {
      name: "echo-semi",
      command: "echo {{val}}",
      description: "Echo",
      parameters: { val: { type: "string", description: "A value" } },
    };
    const execute = registerAndCapture(tool);

    await execute("call-1", { val: "foo;rm -rf /" }, new AbortController().signal, undefined, makeCtx());

    // Semicolon is safely contained inside single quotes
    expect(mockExecuteCommand).toHaveBeenCalledWith("echo 'foo;rm -rf /'", expect.objectContaining({}));
  });

  it("strips surrounding double quotes from placeholder before escaping", async () => {
    mockExecuteCommand.mockResolvedValue("ok");
    const tool: ArmoryTool = {
      name: "describe",
      command: 'jj describe -m "{{message}}"',
      description: "Describe a commit",
      parameters: { message: { type: "string", description: "Commit message" } },
    };
    const execute = registerAndCapture(tool);

    await execute("call-1", { message: "fix: something" }, new AbortController().signal, undefined, makeCtx());

    expect(mockExecuteCommand).toHaveBeenCalledWith("jj describe -m 'fix: something'", expect.objectContaining({}));
  });

  it("strips surrounding single quotes from placeholder before escaping", async () => {
    mockExecuteCommand.mockResolvedValue("ok");
    const tool: ArmoryTool = {
      name: "echo",
      command: "echo '{{msg}}'",
      description: "Echo",
      parameters: { msg: { type: "string", description: "Message" } },
    };
    const execute = registerAndCapture(tool);

    await execute("call-1", { msg: "hello world" }, new AbortController().signal, undefined, makeCtx());

    expect(mockExecuteCommand).toHaveBeenCalledWith("echo 'hello world'", expect.objectContaining({}));
  });

  it("throws when a declared parameter is missing from params", async () => {
    const tool: ArmoryTool = {
      name: "missing-param",
      command: "echo {{name}}",
      description: "Echo name",
      parameters: { name: { type: "string", description: "Name" } },
    };
    const execute = registerAndCapture(tool);

    await expect(execute("call-1", {}, new AbortController().signal, undefined, makeCtx())).rejects.toThrow(
      "Missing required parameter: name",
    );
  });

  it("does not interpolate when tool has no parameters defined", async () => {
    mockExecuteCommand.mockResolvedValue("ok");
    const tool: ArmoryTool = {
      name: "plain",
      command: "echo hello",
      description: "Plain tool",
    };
    const execute = registerAndCapture(tool);

    await execute("call-1", {}, new AbortController().signal, undefined, makeCtx());

    expect(mockExecuteCommand).toHaveBeenCalledWith("echo hello", expect.objectContaining({}));
  });

  it("registers with a dynamic schema when parameters are defined", () => {
    const tool: ArmoryTool = {
      name: "typed-tool",
      command: "run {{target}}",
      description: "Run target",
      parameters: { target: { type: "string", description: "The target to run" } },
    };
    let capturedDef: { parameters: unknown } | undefined;
    const pi = {
      registerTool: vi.fn((def: { parameters: unknown }) => {
        capturedDef = def;
      }),
    } as unknown as ExtensionAPI;

    registerArmoryTool(pi, tool);

    // Schema should have a 'target' property (TypeBox object)
    const schema = capturedDef?.parameters as { properties?: Record<string, unknown> };
    expect(schema).toBeDefined();
    expect(schema.properties).toHaveProperty("target");
  });

  it("registers with empty schema when no parameters are defined", () => {
    const tool: ArmoryTool = {
      name: "no-params",
      command: "echo hi",
      description: "No params",
    };
    let capturedDef: { parameters: unknown } | undefined;
    const pi = {
      registerTool: vi.fn((def: { parameters: unknown }) => {
        capturedDef = def;
      }),
    } as unknown as ExtensionAPI;

    registerArmoryTool(pi, tool);

    const schema = capturedDef?.parameters as { properties?: Record<string, unknown> };
    expect(schema).toBeDefined();
    // No declared properties
    expect(Object.keys(schema.properties ?? {})).toHaveLength(0);
  });
});
