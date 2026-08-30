import { describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-ai");

vi.mock("../src/config.js", () => ({
  saveConfig: vi.fn(),
}));

vi.mock("../src/register-tool.js", () => {
  const sessionRegistry = new Map<string, unknown>();
  return {
    registerArmoryTool: vi.fn(),
    sessionRegistry,
    approvalRegistry: new Map<string, unknown>(),
  };
});

import { streamSimple } from "@earendil-works/pi-ai";
import { saveConfig } from "../src/config.js";
import { registerArmoryTool, sessionRegistry } from "../src/register-tool.js";
import { registerRequestTool } from "../src/request-tool.js";

describe("request_tool session destination", () => {
  it("registers session-only tools without persisting them", async () => {
    (sessionRegistry as Map<string, unknown>).clear();

    let requestTool: { execute: (...args: unknown[]) => Promise<unknown> } | undefined;
    const eventEmit = vi.fn();
    const pi = {
      registerTool: vi.fn((tool) => {
        requestTool = tool as typeof requestTool;
      }),
      events: { emit: eventEmit },
    };

    registerRequestTool(pi as never, "/project");

    expect(requestTool).toBeDefined();

    const ctx = {
      hasUI: true,
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

  it("does not store project-destination tools in session registry", async () => {
    (sessionRegistry as Map<string, unknown>).clear();
    (sessionRegistry as Map<string, unknown>).set("run_tests", { name: "run_tests" });

    let requestTool: { execute: (...args: unknown[]) => Promise<unknown> } | undefined;
    const pi = {
      registerTool: vi.fn((tool) => {
        requestTool = tool as typeof requestTool;
      }),
      events: { emit: vi.fn() },
    };

    registerRequestTool(pi as never, "/project");

    const ctx = {
      hasUI: true,
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

    expect(sessionRegistry.has("run_tests")).toBe(false);
  });

  it("emits herdr:blocked active before showToolEditor and inactive after", async () => {
    (sessionRegistry as Map<string, unknown>).clear();

    let requestTool: { execute: (...args: unknown[]) => Promise<unknown> } | undefined;
    const emitMock = vi.fn();
    const pi = {
      registerTool: vi.fn((tool) => {
        requestTool = tool as typeof requestTool;
      }),
      events: { emit: emitMock },
    };

    registerRequestTool(pi as never, "/project");

    const ctx = {
      hasUI: true,
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

    await requestTool?.execute(
      "tool-call-id",
      { command: "npm test", reasoning: "Run tests" },
      new AbortController().signal,
      undefined,
      ctx,
    );

    expect(emitMock).toHaveBeenNthCalledWith(1, "herdr:blocked", { active: true, label: "review proposed tool" });
    expect(emitMock).toHaveBeenCalledWith("herdr:blocked", { active: false });
  });

  it("emits herdr:blocked inactive in finally when showToolEditor rejects", async () => {
    (sessionRegistry as Map<string, unknown>).clear();

    let requestTool: { execute: (...args: unknown[]) => Promise<unknown> } | undefined;
    const emitMock = vi.fn();
    const pi = {
      registerTool: vi.fn((tool) => {
        requestTool = tool as typeof requestTool;
      }),
      events: { emit: emitMock },
    };

    registerRequestTool(pi as never, "/project");

    const ctx = {
      hasUI: true,
      modelRegistry: {},
      model: undefined,
      ui: {
        custom: vi.fn().mockRejectedValue(new Error("form closed")),
      },
    };

    await expect(
      requestTool?.execute(
        "tool-call-id",
        { command: "npm test", reasoning: "Run tests" },
        new AbortController().signal,
        undefined,
        ctx,
      ),
    ).rejects.toThrow("form closed");

    expect(emitMock).toHaveBeenCalledWith("herdr:blocked", { active: false });
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
      events: { emit: vi.fn() },
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
      events: { emit: vi.fn() },
    };

    registerRequestTool(pi as never, "/project");
    expect(requestTool).toBeDefined();

    // biome-ignore lint/suspicious/noExplicitAny: minimal fake model
    const fakeModel: any = { id: "test", name: "test-model" };
    const customMock = vi.fn();
    const ctx = {
      hasUI: true,
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
