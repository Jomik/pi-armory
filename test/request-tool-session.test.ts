import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config.js", () => ({
  saveConfig: vi.fn(),
}));

vi.mock("../src/register-tool.js", () => ({
  registerArmoryTool: vi.fn(),
}));

import { saveConfig } from "../src/config.js";
import { registerArmoryTool } from "../src/register-tool.js";
import { registerRequestTool } from "../src/request-tool.js";

describe("request_tool session destination", () => {
  it("registers session-only tools without persisting them", async () => {
    let requestTool: { execute: (...args: unknown[]) => Promise<unknown> } | undefined;
    const pi = {
      registerTool: vi.fn((tool) => {
        requestTool = tool as typeof requestTool;
      }),
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
    expect(result).toMatchObject({
      content: [{ type: "text", text: "Tool registered as 'run_tests'. You can use it next turn." }],
      terminate: true,
    });
  });
});
