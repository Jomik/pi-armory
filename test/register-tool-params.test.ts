import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ArmoryTool } from "../src/config.js";
import { executeCommand } from "../src/executor.js";
import { interpolateCommand, registerArmoryTool } from "../src/register-tool.js";

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
    };
    const execute = registerAndCapture(tool);

    await expect(execute("call-1", {}, new AbortController().signal, undefined, makeCtx())).rejects.toThrow(
      "Invalid parameters",
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
    };
    let capturedDef: { parameters: unknown } | undefined;
    const pi = {
      registerTool: vi.fn((def: { parameters: unknown }) => {
        capturedDef = def;
      }),
    } as unknown as ExtensionAPI;

    registerArmoryTool(pi, tool);

    // Schema should have a 'target' property derived from the command template
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

  it("interpolates string[] parameter as multiple shell-escaped arguments", async () => {
    mockExecuteCommand.mockResolvedValue("ok");
    const tool: ArmoryTool = {
      name: "jira-view",
      command: "bash jira-view.sh {{key}} {{...fields}}",
      description: "View a Jira issue",
    };
    const execute = registerAndCapture(tool);

    await execute(
      "call-1",
      { key: "PLMA-402", fields: ["summary", "status", "description"] },
      new AbortController().signal,
      undefined,
      makeCtx(),
    );

    expect(mockExecuteCommand).toHaveBeenCalledWith(
      "bash jira-view.sh 'PLMA-402' 'summary' 'status' 'description'",
      expect.objectContaining({}),
    );
  });

  it("shell-escapes each element in a string[] parameter", async () => {
    mockExecuteCommand.mockResolvedValue("ok");
    const tool: ArmoryTool = {
      name: "multi-arg",
      command: "run {{...args}}",
      description: "Run with args",
    };
    const execute = registerAndCapture(tool);

    await execute(
      "call-1",
      { args: ["hello world", "it's here", "foo;bar"] },
      new AbortController().signal,
      undefined,
      makeCtx(),
    );

    expect(mockExecuteCommand).toHaveBeenCalledWith(
      "run 'hello world' 'it'\\''s here' 'foo;bar'",
      expect.objectContaining({}),
    );
  });

  it("omits optional parameter when not provided", async () => {
    mockExecuteCommand.mockResolvedValue("ok");
    const tool: ArmoryTool = {
      name: "jira-view",
      command: "bash jira-view.sh {{key}} {{...fields?}}",
      description: "View a Jira issue",
    };
    const execute = registerAndCapture(tool);

    await execute("call-1", { key: "PLMA-402" }, new AbortController().signal, undefined, makeCtx());

    expect(mockExecuteCommand).toHaveBeenCalledWith("bash jira-view.sh 'PLMA-402'", expect.objectContaining({}));
  });

  it("omits optional string parameter when not provided", async () => {
    mockExecuteCommand.mockResolvedValue("ok");
    const tool: ArmoryTool = {
      name: "greet",
      command: "echo {{name}} {{suffix?}}",
      description: "Greet",
    };
    const execute = registerAndCapture(tool);

    await execute("call-1", { name: "world" }, new AbortController().signal, undefined, makeCtx());

    expect(mockExecuteCommand).toHaveBeenCalledWith("echo 'world'", expect.objectContaining({}));
  });

  it("includes optional parameter when provided", async () => {
    mockExecuteCommand.mockResolvedValue("ok");
    const tool: ArmoryTool = {
      name: "jira-view",
      command: "bash jira-view.sh {{key}} {{...fields?}}",
      description: "View a Jira issue",
    };
    const execute = registerAndCapture(tool);

    await execute(
      "call-1",
      { key: "PLMA-402", fields: ["summary", "status"] },
      new AbortController().signal,
      undefined,
      makeCtx(),
    );

    expect(mockExecuteCommand).toHaveBeenCalledWith(
      "bash jira-view.sh 'PLMA-402' 'summary' 'status'",
      expect.objectContaining({}),
    );
  });

  it("still throws for missing required parameters", async () => {
    const tool: ArmoryTool = {
      name: "required",
      command: "echo {{name}} {{optional?}}",
      description: "Test",
    };
    const execute = registerAndCapture(tool);

    await expect(execute("call-1", {}, new AbortController().signal, undefined, makeCtx())).rejects.toThrow(
      "Invalid parameters",
    );
  });

  it("throws for required string[] when empty array is passed", async () => {
    const tool: ArmoryTool = {
      name: "required-array",
      command: "run {{...args}}",
      description: "Test",
    };
    const execute = registerAndCapture(tool);

    await expect(execute("call-1", { args: [] }, new AbortController().signal, undefined, makeCtx())).rejects.toThrow(
      "Invalid parameters",
    );
  });

  it("rejects optional string[] when empty array is passed", async () => {
    const tool: ArmoryTool = {
      name: "optional-empty",
      command: "run {{name}} {{...args?}}",
      description: "Test",
    };
    const execute = registerAndCapture(tool);

    await expect(
      execute("call-1", { name: "hello", args: [] }, new AbortController().signal, undefined, makeCtx()),
    ).rejects.toThrow("Invalid parameters");
  });

  it("registers optional string[] as Type.Optional(Type.Array) in schema", () => {
    const tool: ArmoryTool = {
      name: "schema-test",
      command: "run {{required}} {{...optional?}}",
      description: "Test",
    };
    let capturedDef: { parameters: { properties?: Record<string, { type?: string; items?: unknown }> } } | undefined;
    const pi = {
      registerTool: vi.fn((def: typeof capturedDef) => {
        capturedDef = def;
      }),
    } as unknown as ExtensionAPI;

    registerArmoryTool(pi, tool);

    const props = capturedDef?.parameters?.properties;
    expect(props).toBeDefined();
    // Required string param derived from {{required}}
    expect(props?.required?.type).toBe("string");
    // Optional array param derived from {{...optional?}} — Array has type=array + items
    expect(props?.optional?.type).toBe("array");
    expect(props?.optional?.items).toBeDefined();
  });

  it("handles template syntax {{...fields?}} for variadic optional via paramDefs", async () => {
    mockExecuteCommand.mockResolvedValue("ok");
    const tool: ArmoryTool = {
      name: "template-syntax",
      command: "bash script.sh {{key}} {{...fields?}}",
      description: "Test template syntax",
    };
    const execute = registerAndCapture(tool);

    // With fields provided
    await execute("call-1", { key: "ABC-1", fields: ["a", "b"] }, new AbortController().signal, undefined, makeCtx());
    expect(mockExecuteCommand).toHaveBeenCalledWith("bash script.sh 'ABC-1' 'a' 'b'", expect.objectContaining({}));
  });

  it("handles template syntax {{...fields?}} with fields omitted", async () => {
    mockExecuteCommand.mockResolvedValue("ok");
    const tool: ArmoryTool = {
      name: "template-omit",
      command: "bash script.sh {{key}} {{...fields?}}",
      description: "Test template syntax",
    };
    const execute = registerAndCapture(tool);

    await execute("call-1", { key: "ABC-1" }, new AbortController().signal, undefined, makeCtx());
    expect(mockExecuteCommand).toHaveBeenCalledWith("bash script.sh 'ABC-1'", expect.objectContaining({}));
  });

  it("interpolateCommand detects variadic from template syntax without paramDefs", () => {
    const result = interpolateCommand("run {{...args}}", { args: ["a", "b", "c"] });
    expect(result).toBe("run 'a' 'b' 'c'");
  });

  it("interpolateCommand detects optional from template syntax without paramDefs", () => {
    const result = interpolateCommand("run {{key}} {{suffix?}}", { key: "hello" });
    expect(result).toBe("run 'hello'");
  });

  it("handles quoted placeholder with variadic modifier", async () => {
    mockExecuteCommand.mockResolvedValue("ok");
    const tool: ArmoryTool = {
      name: "quoted-variadic",
      command: 'run "{{...args}}"',
      description: "Test quoted variadic",
    };
    const execute = registerAndCapture(tool);

    await execute("call-1", { args: ["x", "y"] }, new AbortController().signal, undefined, makeCtx());

    expect(mockExecuteCommand).toHaveBeenCalledWith("run 'x' 'y'", expect.objectContaining({}));
  });

  it("handles quoted placeholder with optional modifier", async () => {
    mockExecuteCommand.mockResolvedValue("ok");
    const tool: ArmoryTool = {
      name: "quoted-optional",
      command: "run {{key}} '{{suffix?}}'",
      description: "Test quoted optional",
    };
    const execute = registerAndCapture(tool);

    await execute("call-1", { key: "hello" }, new AbortController().signal, undefined, makeCtx());

    expect(mockExecuteCommand).toHaveBeenCalledWith("run 'hello'", expect.objectContaining({}));
  });

  // ─── Flag parameter tests ──────────────────────────────────────────────────

  describe("flag parameters — boolean flags", () => {
    it("required boolean flag: true emits the flag", () => {
      const result = interpolateCommand("echo {{--verbose}}", { verbose: true });
      expect(result).toBe("echo --verbose");
    });

    it("required boolean flag: false emits nothing", () => {
      const result = interpolateCommand("echo {{--verbose}}", { verbose: false });
      expect(result).toBe("echo");
    });

    it("required boolean flag: missing throws Missing required parameter", () => {
      expect(() => interpolateCommand("echo {{--verbose}}", {})).toThrow("Missing required parameter: verbose");
    });

    it("optional boolean flag: true emits the flag", () => {
      const result = interpolateCommand("ls {{--all?}}", { all: true });
      expect(result).toBe("ls --all");
    });

    it("optional boolean flag: omitted emits nothing", () => {
      const result = interpolateCommand("ls {{--all?}}", {});
      expect(result).toBe("ls");
    });

    it("optional boolean flag: false emits nothing", () => {
      const result = interpolateCommand("ls {{--all?}}", { all: false });
      expect(result).toBe("ls");
    });

    it("short boolean flag: true emits -l", () => {
      const result = interpolateCommand("ls {{-l?}}", { l: true });
      expect(result).toBe("ls -l");
    });

    it("short boolean flag: omitted emits nothing", () => {
      const result = interpolateCommand("ls {{-l?}}", {});
      expect(result).toBe("ls");
    });

    it("boolean flag builds Type.Boolean schema", () => {
      const tool: ArmoryTool = { name: "t", command: "cmd {{--verbose}}", description: "test" };
      let capturedDef: { parameters: { properties?: Record<string, { type?: string }> } } | undefined;
      const pi = {
        registerTool: vi.fn((def: typeof capturedDef) => {
          capturedDef = def;
        }),
      } as unknown as ExtensionAPI;
      registerArmoryTool(pi, tool);
      expect(capturedDef?.parameters?.properties?.verbose?.type).toBe("boolean");
    });

    it("optional boolean flag builds Type.Optional(Type.Boolean) schema", () => {
      const tool: ArmoryTool = { name: "t", command: "cmd {{--verbose?}}", description: "test" };
      let capturedDef: { parameters: { properties?: Record<string, { type?: string }> } } | undefined;
      const pi = {
        registerTool: vi.fn((def: typeof capturedDef) => {
          capturedDef = def;
        }),
      } as unknown as ExtensionAPI;
      registerArmoryTool(pi, tool);
      // Type.Optional wraps — the property should still have type boolean
      expect(capturedDef?.parameters?.properties?.verbose?.type).toBe("boolean");
    });

    it("required boolean flag: registered tool validates boolean type", async () => {
      const tool: ArmoryTool = { name: "t", command: "cmd {{--verbose}}", description: "test" };
      const execute = registerAndCapture(tool);
      // Missing param → validation error
      await expect(execute("c", {}, new AbortController().signal, undefined, makeCtx())).rejects.toThrow(
        "Invalid parameters",
      );
    });

    it("required boolean flag: registered tool executes with true", async () => {
      mockExecuteCommand.mockResolvedValue("ok");
      const tool: ArmoryTool = { name: "t", command: "cmd {{--verbose}}", description: "test" };
      const execute = registerAndCapture(tool);
      await execute("c", { verbose: true }, new AbortController().signal, undefined, makeCtx());
      expect(mockExecuteCommand).toHaveBeenCalledWith("cmd --verbose", expect.objectContaining({}));
    });

    it("required boolean flag: registered tool executes with false", async () => {
      mockExecuteCommand.mockResolvedValue("ok");
      const tool: ArmoryTool = { name: "t", command: "cmd {{--verbose}}", description: "test" };
      const execute = registerAndCapture(tool);
      await execute("c", { verbose: false }, new AbortController().signal, undefined, makeCtx());
      expect(mockExecuteCommand).toHaveBeenCalledWith("cmd", expect.objectContaining({}));
    });
  });

  describe("flag parameters — flag+value", () => {
    it("required flag+value: emits flag and shell-escaped value", () => {
      const result = interpolateCommand("git commit {{--message message}}", { message: "fix bug" });
      expect(result).toBe("git commit --message 'fix bug'");
    });

    it("required flag+value: missing throws Missing required parameter", () => {
      expect(() => interpolateCommand("git commit {{--message message}}", {})).toThrow(
        "Missing required parameter: message",
      );
    });

    it("optional flag+value: provided emits flag and value", () => {
      const result = interpolateCommand("git log {{--author author?}}", { author: "alice" });
      expect(result).toBe("git log --author 'alice'");
    });

    it("optional flag+value: omitted emits nothing", () => {
      const result = interpolateCommand("git log {{--author author?}}", {});
      expect(result).toBe("git log");
    });

    it("short flag+value: emits -m and shell-escaped value", () => {
      const result = interpolateCommand("git commit {{-m message}}", { message: "fix bug" });
      expect(result).toBe("git commit -m 'fix bug'");
    });

    it("short flag+value: shell-escapes value with quotes", () => {
      const result = interpolateCommand("git commit {{-m message}}", { message: "it's fixed" });
      expect(result).toBe("git commit -m 'it'\\''s fixed'");
    });

    it("optional short flag+value: omitted emits nothing", () => {
      const result = interpolateCommand("git log {{-n count?}}", {});
      expect(result).toBe("git log");
    });

    it("flag+value builds Type.String schema", () => {
      const tool: ArmoryTool = { name: "t", command: "git commit {{--message message}}", description: "test" };
      let capturedDef: { parameters: { properties?: Record<string, { type?: string }> } } | undefined;
      const pi = {
        registerTool: vi.fn((def: typeof capturedDef) => {
          capturedDef = def;
        }),
      } as unknown as ExtensionAPI;
      registerArmoryTool(pi, tool);
      expect(capturedDef?.parameters?.properties?.message?.type).toBe("string");
    });

    it("required flag+value: registered tool validates string type", async () => {
      const tool: ArmoryTool = { name: "t", command: "git commit {{--message message}}", description: "test" };
      const execute = registerAndCapture(tool);
      await expect(execute("c", {}, new AbortController().signal, undefined, makeCtx())).rejects.toThrow(
        "Invalid parameters",
      );
    });

    it("required flag+value: registered tool executes with value", async () => {
      mockExecuteCommand.mockResolvedValue("ok");
      const tool: ArmoryTool = { name: "t", command: "git commit {{--message message}}", description: "test" };
      const execute = registerAndCapture(tool);
      await execute("c", { message: "add feature" }, new AbortController().signal, undefined, makeCtx());
      expect(mockExecuteCommand).toHaveBeenCalledWith(
        "git commit --message 'add feature'",
        expect.objectContaining({}),
      );
    });

    it("optional flag+value: registered tool omits when not provided", async () => {
      mockExecuteCommand.mockResolvedValue("ok");
      const tool: ArmoryTool = { name: "t", command: "git log {{--author author?}}", description: "test" };
      const execute = registerAndCapture(tool);
      await execute("c", {}, new AbortController().signal, undefined, makeCtx());
      expect(mockExecuteCommand).toHaveBeenCalledWith("git log", expect.objectContaining({}));
    });
  });

  describe("flag parameters — mixed with regular params", () => {
    it("all flags and regular param provided", () => {
      const result = interpolateCommand("git log {{--oneline?}} {{-n count?}} {{path}}", {
        path: "src/",
        oneline: true,
        count: "10",
      });
      expect(result).toBe("git log --oneline -n '10' 'src/'");
    });

    it("all optional flags omitted, regular param provided", () => {
      const result = interpolateCommand("git log {{--oneline?}} {{-n count?}} {{path}}", { path: "src/" });
      expect(result).toBe("git log 'src/'");
    });

    it("boolean flag false, flag+value omitted, regular param provided", () => {
      const result = interpolateCommand("git log {{--oneline?}} {{-n count?}} {{path}}", {
        path: "main.ts",
        oneline: false,
      });
      expect(result).toBe("git log 'main.ts'");
    });

    it("registered tool with mixed flags and regular params", async () => {
      mockExecuteCommand.mockResolvedValue("ok");
      const tool: ArmoryTool = {
        name: "git-log",
        command: "git log {{--oneline?}} {{-n count?}} {{path}}",
        description: "Git log",
      };
      const execute = registerAndCapture(tool);
      await execute("c", { path: ".", oneline: true, count: "5" }, new AbortController().signal, undefined, makeCtx());
      expect(mockExecuteCommand).toHaveBeenCalledWith("git log --oneline -n '5' '.'", expect.objectContaining({}));
    });

    it("registered tool with mixed flags: optional flags omitted", async () => {
      mockExecuteCommand.mockResolvedValue("ok");
      const tool: ArmoryTool = {
        name: "git-log",
        command: "git log {{--oneline?}} {{-n count?}} {{path}}",
        description: "Git log",
      };
      const execute = registerAndCapture(tool);
      await execute("c", { path: "." }, new AbortController().signal, undefined, makeCtx());
      expect(mockExecuteCommand).toHaveBeenCalledWith("git log '.'", expect.objectContaining({}));
    });
  });
});
