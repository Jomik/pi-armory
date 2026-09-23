import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-ai/compat");

vi.mock("../src/config.js", () => ({
  getDestinationEnvSets: vi.fn().mockResolvedValue({}),
  saveConfig: vi.fn().mockResolvedValue({}),
}));

vi.mock("../src/register-tool.js", () => {
  const sessionRegistry = new Map<string, unknown>();
  return {
    registerArmoryTool: vi.fn(),
    sessionRegistry,
    approvalRegistry: new Map<string, unknown>(),
  };
});

import { streamSimple } from "@earendil-works/pi-ai/compat";
import { getDestinationEnvSets, saveConfig } from "../src/config.js";
import { registerArmoryTool, sessionRegistry } from "../src/register-tool.js";
import { registerRequestTool } from "../src/request-tool.js";

describe("request_tool session destination", () => {
  beforeEach(() => {
    vi.mocked(getDestinationEnvSets).mockReset().mockResolvedValue({});
    vi.mocked(saveConfig).mockReset().mockResolvedValue({});
    vi.mocked(registerArmoryTool).mockClear();
  });
  it("registers session-only tools without persisting them", async () => {
    (sessionRegistry as Map<string, unknown>).clear();

    let requestTool: { execute: (...args: unknown[]) => Promise<unknown> } | undefined;
    const pi = {
      registerTool: vi.fn((tool) => {
        requestTool = tool as typeof requestTool;
      }),
      getActiveTools: vi.fn(() => [] as string[]),
      setActiveTools: vi.fn(),
    };

    registerRequestTool(pi as never, "/project");

    expect(requestTool).toBeDefined();

    const ctx = {
      hasUI: true,
      mode: "tui",
      modelRegistry: {},
      model: undefined,
      ui: {
        custom: vi.fn().mockResolvedValue({
          name: "run_tests",
          command: "npm test",
          description: "Run tests",
          guidelines: [],
          requiresApproval: false,
          destination: "session",
        }),
      },
    };

    const result = await requestTool?.execute(
      "tool-call-id",
      { command: "npm test", reasoning: "Run tests" },
      new AbortController().signal,
      undefined,
      ctx,
    );

    expect(saveConfig).not.toHaveBeenCalled();
    expect(registerArmoryTool).toHaveBeenCalledWith(
      pi,
      expect.objectContaining({ name: "run_tests", command: "npm test", description: "Run tests" }),
    );
    // Session tool must be stored in the in-memory registry
    expect(sessionRegistry.get("run_tests")).toMatchObject({ name: "run_tests", command: "npm test" });
    expect(result).toMatchObject({
      content: [{ type: "text", text: "Tool registered as 'run_tests'. You can use it next turn." }],
      terminate: true,
    });
  });

  it("passes a drafted when to the form, registers the tool, and syncs its active-state via syncToolCondition", async () => {
    (sessionRegistry as Map<string, unknown>).clear();

    const mockStreamSimple = vi.mocked(streamSimple);
    const draftedJson = JSON.stringify({
      name: "jj_status",
      command: "jj st",
      description: "Show jj status",
      requires_approval: false,
      guidelines: [],
      destination: "session",
      when: "git",
    });
    mockStreamSimple.mockReturnValueOnce(
      (async function* () {
        yield { type: "text_delta" as const, delta: draftedJson };
        // biome-ignore lint/suspicious/noExplicitAny: test mock returning async generator
      })() as any,
    );

    let requestTool: { execute: (...args: unknown[]) => Promise<unknown> } | undefined;
    const pi = {
      registerTool: vi.fn((tool) => {
        requestTool = tool as typeof requestTool;
      }),
      getActiveTools: vi.fn(() => [] as string[]),
      setActiveTools: vi.fn(),
    };

    registerRequestTool(pi as never, "/project");

    let renderedForm = "";
    const customMock = vi.fn(
      (
        render: (
          tui: unknown,
          theme: unknown,
          keybindings: unknown,
          done: (result: unknown) => void,
        ) => { render(width: number): string[] },
      ) =>
        new Promise((resolve) => {
          const tui = { requestRender: vi.fn(), terminal: { rows: 24, columns: 100 } };
          const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
          const panel = render(tui, theme, {}, resolve);
          renderedForm = panel.render(100).join("\n");
          resolve({
            name: "jj_status",
            command: "jj st",
            description: "Show jj status",
            guidelines: [],
            requiresApproval: false,
            destination: "session",
            when: "git",
          });
        }),
    );
    const ctx = {
      hasUI: true,
      mode: "tui",
      // No real repository cwd; detectRepositoryType resolves to undefined, so a
      // "git"-conditioned tool mismatches and must not be activated.
      cwd: undefined,
      modelRegistry: {
        getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: "test-key" }),
      },
      // biome-ignore lint/suspicious/noExplicitAny: minimal fake model
      model: { id: "test", name: "test-model" } as any,
      ui: { custom: customMock },
    };

    const result = await requestTool?.execute(
      "tool-call-id",
      { command: "jj st", reasoning: "Show jj status" },
      new AbortController().signal,
      undefined,
      ctx,
    );

    // The drafted "git" when reached the form's initial condition state.
    expect(renderedForm).toMatch(/● Git/);
    expect(registerArmoryTool).toHaveBeenCalledWith(pi, expect.objectContaining({ name: "jj_status", when: "git" }));
    // syncToolCondition is real here (only config.js/register-tool.js are mocked); with no
    // real repository at ctx.cwd, the "git" condition mismatches, so the tool must not activate.
    expect(pi.getActiveTools).toHaveBeenCalled();
    expect(pi.setActiveTools).not.toHaveBeenCalled();
    expect(result).toMatchObject({ terminate: true });
  });

  it("registers project tools with the saved config's env sets, not in session registry", async () => {
    (sessionRegistry as Map<string, unknown>).clear();
    const envSets = { common: { TOKEN: "secret" } };
    vi.mocked(getDestinationEnvSets).mockImplementation(async (dest) => (dest === "project" ? envSets : {}));
    vi.mocked(saveConfig).mockResolvedValue(envSets);
    (sessionRegistry as Map<string, unknown>).set("run_tests", { name: "run_tests" });

    let requestTool: { execute: (...args: unknown[]) => Promise<unknown> } | undefined;
    const pi = {
      registerTool: vi.fn((tool) => {
        requestTool = tool as typeof requestTool;
      }),
      getActiveTools: vi.fn(() => [] as string[]),
      setActiveTools: vi.fn(),
    };

    registerRequestTool(pi as never, "/project");

    const ctx = {
      hasUI: true,
      mode: "tui",
      modelRegistry: {},
      model: undefined,
      ui: {
        custom: vi.fn().mockResolvedValue({
          name: "run_tests",
          command: "npm test",
          description: "Run tests",
          guidelines: [],
          requiresApproval: false,
          destination: "project",
        }),
      },
    };

    await requestTool?.execute(
      "tool-call-id",
      { command: "npm test", reasoning: "Run tests" },
      new AbortController().signal,
      undefined,
      ctx,
    );

    expect(saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ name: "run_tests" }),
      "project",
      "/project",
      undefined,
      envSets,
    );
    expect(getDestinationEnvSets).toHaveBeenCalledTimes(2);
    expect(getDestinationEnvSets).toHaveBeenCalledWith("project", "/project");
    expect(getDestinationEnvSets).toHaveBeenCalledWith("global", "/project");
    expect(registerArmoryTool).toHaveBeenCalledWith(pi, expect.objectContaining({ name: "run_tests" }), envSets);
    expect(sessionRegistry.has("run_tests")).toBe(false);
  });

  it.each([
    "project",
    "global",
  ] as const)("saves selected %s sets and registers using the save snapshot", async (destination) => {
    (sessionRegistry as Map<string, unknown>).clear();
    const displayed = { common: { TOKEN: { env: "TOKEN" } } };
    const saved = { common: { TOKEN: { env: "TOKEN" } }, later: { X: "value" } };
    vi.mocked(getDestinationEnvSets).mockImplementation(async (scope) => (scope === destination ? displayed : {}));
    vi.mocked(saveConfig).mockResolvedValue(saved);
    let requestTool: { execute: (...args: unknown[]) => Promise<unknown> } | undefined;
    const pi = {
      registerTool: vi.fn((tool) => {
        requestTool = tool as typeof requestTool;
      }),
      getActiveTools: vi.fn(() => [] as string[]),
      setActiveTools: vi.fn(),
    };
    registerRequestTool(pi as never, "/project");
    const ctx = {
      hasUI: true,
      mode: "tui",
      cwd: "/project",
      modelRegistry: {},
      model: undefined,
      ui: {
        custom: vi.fn().mockResolvedValue({
          name: "run_tests",
          command: "npm test",
          description: "Run tests",
          guidelines: [],
          requiresApproval: false,
          destination,
          envFrom: ["common"],
        }),
      },
    };
    await requestTool?.execute(
      "id",
      { command: "npm test", reasoning: "Run tests" },
      new AbortController().signal,
      undefined,
      ctx,
    );
    expect(getDestinationEnvSets).toHaveBeenCalledTimes(2);
    expect(ctx.ui.custom).toHaveBeenCalled();
    const tool = expect.objectContaining({ name: "run_tests", envFrom: ["common"] });
    expect(saveConfig).toHaveBeenCalledWith(tool, destination, "/project", undefined, displayed);
    expect(registerArmoryTool).toHaveBeenCalledWith(pi, tool, saved);
    expect(sessionRegistry.has("run_tests")).toBe(false);
  });

  it("isolates an invalid unrelated scope and does not allow a failed save to mutate registries", async () => {
    (sessionRegistry as Map<string, unknown>).clear();
    sessionRegistry.set("run_tests", { name: "old" });
    vi.mocked(getDestinationEnvSets).mockImplementation(async (scope) => {
      if (scope === "global") throw new Error("Invalid config");
      return { common: { TOKEN: "value" } };
    });
    vi.mocked(saveConfig).mockRejectedValue(new Error("Selected env set changed; reload before saving"));
    let requestTool: { execute: (...args: unknown[]) => Promise<unknown> } | undefined;
    const pi = {
      registerTool: vi.fn((tool) => {
        requestTool = tool as typeof requestTool;
      }),
      getActiveTools: vi.fn(() => [] as string[]),
      setActiveTools: vi.fn(),
    };
    registerRequestTool(pi as never, "/project");
    const ctx = {
      hasUI: true,
      mode: "tui",
      cwd: "/project",
      modelRegistry: {},
      model: undefined,
      ui: {
        custom: vi.fn().mockResolvedValue({
          name: "run_tests",
          command: "npm test",
          description: "Run tests",
          guidelines: [],
          requiresApproval: false,
          destination: "project",
          envFrom: ["common"],
        }),
      },
    };
    await expect(
      requestTool?.execute(
        "id",
        { command: "npm test", reasoning: "Run tests" },
        new AbortController().signal,
        undefined,
        ctx,
      ),
    ).rejects.toThrow("Selected env set changed");
    expect(saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ envFrom: ["common"] }),
      "project",
      "/project",
      undefined,
      { common: { TOKEN: "value" } },
    );
    expect(registerArmoryTool).not.toHaveBeenCalled();
    expect(sessionRegistry.get("run_tests")).toEqual({ name: "old" });
    expect(pi.setActiveTools).not.toHaveBeenCalled();
  });

  it("passes an empty snapshot for an unavailable selected destination instead of silently registering", async () => {
    (sessionRegistry as Map<string, unknown>).clear();
    vi.mocked(getDestinationEnvSets).mockImplementation(async (scope) => {
      if (scope === "global") throw new Error("unreadable");
      return { common: { TOKEN: "value" } };
    });
    vi.mocked(saveConfig).mockRejectedValue(new Error("Selected env set changed; reload before saving"));
    let requestTool: { execute: (...args: unknown[]) => Promise<unknown> } | undefined;
    const pi = {
      registerTool: vi.fn((tool) => {
        requestTool = tool as typeof requestTool;
      }),
      getActiveTools: vi.fn(() => [] as string[]),
      setActiveTools: vi.fn(),
    };
    registerRequestTool(pi as never, "/project");
    const ctx = {
      hasUI: true,
      mode: "tui",
      cwd: "/project",
      modelRegistry: {},
      model: undefined,
      ui: {
        custom: vi.fn().mockResolvedValue({
          name: "run_tests",
          command: "npm test",
          description: "Run tests",
          guidelines: [],
          requiresApproval: false,
          destination: "global",
          envFrom: ["common"],
        }),
      },
    };
    await expect(
      requestTool?.execute(
        "id",
        { command: "npm test", reasoning: "Run tests" },
        new AbortController().signal,
        undefined,
        ctx,
      ),
    ).rejects.toThrow("Selected env set changed");
    expect(saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ envFrom: ["common"] }),
      "global",
      "/project",
      undefined,
      {},
    );
    expect(registerArmoryTool).not.toHaveBeenCalled();
  });

  it("discards envFrom for session even if an editor returns selected refs", async () => {
    (sessionRegistry as Map<string, unknown>).clear();
    vi.mocked(getDestinationEnvSets).mockRejectedValue(new Error("unreadable"));
    let requestTool: { execute: (...args: unknown[]) => Promise<unknown> } | undefined;
    const pi = {
      registerTool: vi.fn((tool) => {
        requestTool = tool as typeof requestTool;
      }),
      getActiveTools: vi.fn(() => [] as string[]),
      setActiveTools: vi.fn(),
    };
    registerRequestTool(pi as never, "/project");
    const ctx = {
      hasUI: true,
      mode: "tui",
      cwd: "/project",
      modelRegistry: {},
      model: undefined,
      ui: {
        custom: vi.fn().mockResolvedValue({
          name: "run_tests",
          command: "npm test",
          description: "Run tests",
          guidelines: [],
          requiresApproval: false,
          destination: "session",
          envFrom: ["common"],
        }),
      },
    };
    await requestTool?.execute(
      "id",
      { command: "npm test", reasoning: "Run tests" },
      new AbortController().signal,
      undefined,
      ctx,
    );
    expect(saveConfig).not.toHaveBeenCalled();
    expect(registerArmoryTool).toHaveBeenCalledWith(pi, expect.objectContaining({ envFrom: [] }));
    expect(sessionRegistry.get("run_tests")).toMatchObject({ envFrom: [] });
  });

  it("rejects before drafting when ctx.mode is not 'tui'", async () => {
    (sessionRegistry as Map<string, unknown>).clear();

    let requestTool: { execute: (...args: unknown[]) => Promise<unknown> } | undefined;
    const pi = {
      registerTool: vi.fn((tool) => {
        requestTool = tool as typeof requestTool;
      }),
    };

    registerRequestTool(pi as never, "/project");

    const customMock = vi.fn();
    const ctx = {
      hasUI: true,
      mode: "rpc",
      modelRegistry: {
        getApiKeyAndHeaders: vi.fn(),
      },
      model: undefined,
      ui: { custom: customMock },
    };

    const result = await requestTool?.execute(
      "tool-call-id",
      { command: "npm test", reasoning: "Run tests" },
      new AbortController().signal,
      undefined,
      ctx,
    );

    expect(customMock).not.toHaveBeenCalled();
    expect(ctx.modelRegistry.getApiKeyAndHeaders).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("interactive TUI") }],
    });
  });
});

describe("request_tool enterprise baseUrl routing", () => {
  it("passes enterprise baseUrl from auth to streamSimple, not the session model baseUrl", async () => {
    const mockStreamSimple = vi.mocked(streamSimple);

    const validDraftJson = JSON.stringify({
      name: "run_tests",
      command: "npm test",
      description: "Runs the test suite",
      requires_approval: false,
      guidelines: [],
      destination: "session",
    });

    // biome-ignore lint/suspicious/noExplicitAny: capture model from streamSimple call
    let capturedModel: any;
    // biome-ignore lint/suspicious/noExplicitAny: test async-generator mock
    mockStreamSimple.mockImplementation((model: any): any => {
      capturedModel = model;
      return (async function* () {
        yield { type: "text_delta" as const, delta: validDraftJson };
      })();
    });

    let requestTool: { execute: (...args: unknown[]) => Promise<unknown> } | undefined;
    const pi = {
      registerTool: vi.fn((tool) => {
        requestTool = tool as typeof requestTool;
      }),
      getActiveTools: vi.fn(() => [] as string[]),
      setActiveTools: vi.fn(),
    };

    registerRequestTool(pi as never, "/project");
    expect(requestTool).toBeDefined();

    // Session model carries the individual Copilot base URL.
    // biome-ignore lint/suspicious/noExplicitAny: minimal fake model
    const sessionModel: any = {
      id: "copilot-gpt-4o",
      name: "Copilot GPT-4o",
      baseUrl: "https://api.individual.githubcopilot.com",
    };

    const ctx = {
      hasUI: true,
      mode: "tui",
      modelRegistry: {
        // Auth resolution returns the enterprise endpoint — request-tool must
        // propagate this baseUrl to the model passed to draftToolDefinition.
        getApiKeyAndHeaders: vi.fn().mockResolvedValue({
          ok: true,
          apiKey: "ent-api-key",
          headers: { Authorization: "Bearer ent-token" },
          // Newer runtimes resolve the tenant-specific endpoint during authentication.
          baseUrl: "https://api.enterprise.githubcopilot.com",
        }),
      },
      model: sessionModel,
      ui: {
        // Return a valid form result so the execute() path completes normally.
        custom: vi.fn().mockResolvedValue({
          name: "run_tests",
          command: "npm test",
          description: "Runs the test suite",
          guidelines: [],
          requiresApproval: false,
          destination: "session",
        }),
      },
    };

    await requestTool?.execute(
      "tool-call-id",
      { command: "npm test", reasoning: "Run tests" },
      new AbortController().signal,
      undefined,
      ctx,
    );

    expect(capturedModel).toBeDefined();
    expect(capturedModel.baseUrl).toBe("https://api.enterprise.githubcopilot.com");
  });
});

describe("request_tool draft stream terminal error propagation", () => {
  it("rejects with the stream errorMessage and does not open ctx.ui.custom", async () => {
    const mockStreamSimple = vi.mocked(streamSimple);

    // biome-ignore lint/suspicious/noExplicitAny: test async-generator mock
    function makeTerminalErrorStream(errorMessage: string): any {
      return (async function* () {
        yield {
          type: "error" as const,
          reason: "error" as const,
          error: {
            role: "assistant" as const,
            content: [],
            api: "openai-completions" as const,
            provider: "openai",
            model: "test-model",
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "error" as const,
            errorMessage,
            timestamp: 0,
          },
        };
      })();
    }

    mockStreamSimple.mockReturnValue(makeTerminalErrorStream("draft unavailable"));

    let requestTool: { execute: (...args: unknown[]) => Promise<unknown> } | undefined;
    const pi = {
      registerTool: vi.fn((tool) => {
        requestTool = tool as typeof requestTool;
      }),
    };

    registerRequestTool(pi as never, "/project");
    expect(requestTool).toBeDefined();

    // biome-ignore lint/suspicious/noExplicitAny: minimal fake model
    const fakeModel: any = { id: "test", name: "test-model" };
    const customMock = vi.fn();
    const ctx = {
      hasUI: true,
      mode: "tui",
      modelRegistry: {
        getApiKeyAndHeaders: vi.fn().mockResolvedValue({ ok: true, apiKey: "test-key" }),
      },
      model: fakeModel,
      ui: { custom: customMock },
    };

    await expect(
      requestTool?.execute(
        "tool-call-id",
        { command: "npm test", reasoning: "run tests" },
        new AbortController().signal,
        undefined,
        ctx,
      ),
    ).rejects.toThrow("draft unavailable");

    expect(customMock).not.toHaveBeenCalled();
  });
});
