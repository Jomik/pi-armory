import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArmoryTool } from "../src/config.js";

vi.mock("../src/config.js");
vi.mock("../src/register-tool.js");
vi.mock("../src/request-tool.js");

import { loadConfig } from "../src/config.js";
import factory from "../src/index.js";
import { registerArmoryTool } from "../src/register-tool.js";
import { registerRequestTool } from "../src/request-tool.js";

const toolA: ArmoryTool = { name: "tool-a", command: "echo a", description: "Tool A" };
const toolB: ArmoryTool = { name: "tool-b", command: "echo b", description: "Tool B" };

// Minimal fake pi context — factory only passes it through to register functions
const fakePi = {} as Parameters<typeof factory>[0];

describe("factory", () => {
  beforeEach(() => {
    vi.mocked(loadConfig).mockResolvedValue([]);
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("registers each tool from config via registerArmoryTool", async () => {
    vi.mocked(loadConfig).mockResolvedValue([toolA, toolB]);

    await factory(fakePi);

    expect(registerArmoryTool).toHaveBeenCalledTimes(2);
    expect(registerArmoryTool).toHaveBeenCalledWith(fakePi, toolA);
    expect(registerArmoryTool).toHaveBeenCalledWith(fakePi, toolB);
  });

  it("registers request_tool with pi and projectRoot", async () => {
    await factory(fakePi);

    expect(registerRequestTool).toHaveBeenCalledTimes(1);
    expect(registerRequestTool).toHaveBeenCalledWith(fakePi, process.cwd());
  });

  it("registers no armory tools when config is empty, but still registers request_tool", async () => {
    vi.mocked(loadConfig).mockResolvedValue([]);

    await factory(fakePi);

    expect(registerArmoryTool).not.toHaveBeenCalled();
    expect(registerRequestTool).toHaveBeenCalledTimes(1);
  });

  it("propagates errors thrown by loadConfig", async () => {
    vi.mocked(loadConfig).mockRejectedValue(new Error("config read failed"));

    await expect(factory(fakePi)).rejects.toThrow("config read failed");
  });
});
