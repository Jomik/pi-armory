import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ArmoryTool } from "../src/config.js";
import { loadConfig, loadToolWithSource, removeFromConfig, saveConfig } from "../src/config.js";

let tmpDir: string;
let fakeHome: string;
let fakeAgentDir: string;
let projectRoot: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "pi-armory-test-"));
  fakeHome = path.join(tmpDir, "home");
  fakeAgentDir = path.join(fakeHome, ".pi", "agent");
  projectRoot = path.join(tmpDir, "project");
  await mkdir(fakeHome, { recursive: true });
  await mkdir(projectRoot, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

const toolA: ArmoryTool = { name: "tool-a", command: "echo a", description: "Tool A" };
const toolB: ArmoryTool = { name: "tool-b", command: "echo b", description: "Tool B" };
const toolAOverride: ArmoryTool = {
  name: "tool-a",
  command: "echo a-project",
  description: "Tool A (project override)",
  requires_approval: true,
};

async function writeGlobal(tools: ArmoryTool[]) {
  await mkdir(fakeAgentDir, { recursive: true });
  await writeFile(path.join(fakeAgentDir, "armory.json"), `${JSON.stringify({ tools }, null, 2)}\n`);
}

async function writeProject(tools: ArmoryTool[]) {
  const dir = path.join(projectRoot, ".pi");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "armory.json"), `${JSON.stringify({ tools }, null, 2)}\n`);
}

describe("loadConfig", () => {
  it("returns [] when no files exist", async () => {
    const result = await loadConfig(projectRoot, fakeAgentDir);
    expect(result.tools).toEqual([]);
  });

  it("returns global tools when only global file exists", async () => {
    await writeGlobal([toolA, toolB]);
    const result = await loadConfig(projectRoot, fakeAgentDir);
    expect(result.tools).toEqual([toolA, toolB]);
  });

  it("returns project tools when only project file exists", async () => {
    await writeProject([toolA]);
    const result = await loadConfig(projectRoot, fakeAgentDir);
    expect(result.tools).toEqual([toolA]);
  });

  it("merges global and project tools, project overrides by name", async () => {
    await writeGlobal([toolA, toolB]);
    await writeProject([toolAOverride]);
    const result = await loadConfig(projectRoot, fakeAgentDir);
    expect(result.tools).toHaveLength(2);
    expect(result.tools.find((t) => t.name === "tool-a")).toEqual(toolAOverride);
    expect(result.tools.find((t) => t.name === "tool-b")).toEqual(toolB);
  });

  it("returns [] and does not throw on invalid global JSON", async () => {
    await mkdir(fakeAgentDir, { recursive: true });
    await writeFile(path.join(fakeAgentDir, "armory.json"), "not-valid-json");
    const result = await loadConfig(projectRoot, fakeAgentDir);
    expect(result.tools).toEqual([]);
  });

  it("returns [] and does not throw on invalid project JSON", async () => {
    const dir = path.join(projectRoot, ".pi");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "armory.json"), "{bad json");
    const result = await loadConfig(projectRoot, fakeAgentDir);
    expect(result.tools).toEqual([]);
  });

  it("returns draftModel from global config", async () => {
    await mkdir(fakeAgentDir, { recursive: true });
    await writeFile(
      path.join(fakeAgentDir, "armory.json"),
      `${JSON.stringify({ tools: [], draftModel: "fast-model" }, null, 2)}\n`,
    );
    const result = await loadConfig(projectRoot, fakeAgentDir);
    expect(result.draftModel).toBe("fast-model");
  });

  it("project draftModel overrides global draftModel", async () => {
    await mkdir(fakeAgentDir, { recursive: true });
    await writeFile(
      path.join(fakeAgentDir, "armory.json"),
      `${JSON.stringify({ tools: [], draftModel: "global-model" }, null, 2)}\n`,
    );
    const projectDir = path.join(projectRoot, ".pi");
    await mkdir(projectDir, { recursive: true });
    await writeFile(
      path.join(projectDir, "armory.json"),
      `${JSON.stringify({ tools: [], draftModel: "project-model" }, null, 2)}\n`,
    );
    const result = await loadConfig(projectRoot, fakeAgentDir);
    expect(result.draftModel).toBe("project-model");
  });
});

describe("saveConfig", () => {
  it("creates project file if it does not exist", async () => {
    await saveConfig(toolA, "project", projectRoot, fakeAgentDir);
    const content = await readFile(path.join(projectRoot, ".pi", "armory.json"), "utf-8");
    expect(JSON.parse(content)).toEqual({ tools: [toolA] });
  });

  it("creates global file if it does not exist", async () => {
    await saveConfig(toolA, "global", projectRoot, fakeAgentDir);
    const content = await readFile(path.join(fakeAgentDir, "armory.json"), "utf-8");
    expect(JSON.parse(content)).toEqual({ tools: [toolA] });
  });

  it("appends new tool to existing project file", async () => {
    await writeProject([toolA]);
    await saveConfig(toolB, "project", projectRoot, fakeAgentDir);
    const content = await readFile(path.join(projectRoot, ".pi", "armory.json"), "utf-8");
    expect(JSON.parse(content)).toEqual({ tools: [toolA, toolB] });
  });

  it("replaces existing tool by name in project file", async () => {
    await writeProject([toolA, toolB]);
    await saveConfig(toolAOverride, "project", projectRoot, fakeAgentDir);
    const content = await readFile(path.join(projectRoot, ".pi", "armory.json"), "utf-8");
    const parsed = (JSON.parse(content) as { tools: ArmoryTool[] }).tools;
    expect(parsed).toHaveLength(2);
    expect(parsed.find((t) => t.name === "tool-a")).toEqual(toolAOverride);
    expect(parsed.find((t) => t.name === "tool-b")).toEqual(toolB);
  });

  it("preserves draftModel when saving a tool to existing config", async () => {
    const dir = path.join(projectRoot, ".pi");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "armory.json"),
      `${JSON.stringify({ tools: [toolA], draftModel: "anthropic:claude-haiku-4.5" }, null, 2)}\n`,
    );

    await saveConfig(toolB, "project", projectRoot, fakeAgentDir);

    const content = await readFile(path.join(dir, "armory.json"), "utf-8");
    const parsed = JSON.parse(content) as { tools: ArmoryTool[]; draftModel?: string };
    expect(parsed.draftModel).toBe("anthropic:claude-haiku-4.5");
    expect(parsed.tools).toHaveLength(2);
  });

  it("writes pretty-printed JSON with trailing newline", async () => {
    await saveConfig(toolA, "project", projectRoot, fakeAgentDir);
    const content = await readFile(path.join(projectRoot, ".pi", "armory.json"), "utf-8");
    expect(content.endsWith("\n")).toBe(true);
    expect(content).toBe(`${JSON.stringify({ tools: [toolA] }, null, 2)}\n`);
  });
});

describe("loadToolWithSource", () => {
  it("returns null when tool does not exist in either config", async () => {
    const result = await loadToolWithSource("nonexistent", projectRoot, fakeAgentDir);
    expect(result).toBeNull();
  });

  it("returns global tool when it exists only in global config", async () => {
    await writeGlobal([toolA, toolB]);
    const result = await loadToolWithSource("tool-a", projectRoot, fakeAgentDir);
    expect(result).toEqual({ tool: toolA, source: "global" });
  });

  it("returns project tool when it exists only in project config", async () => {
    await writeProject([toolA]);
    const result = await loadToolWithSource("tool-a", projectRoot, fakeAgentDir);
    expect(result).toEqual({ tool: toolA, source: "project" });
  });

  it("project tool takes precedence over global tool with same name", async () => {
    await writeGlobal([toolA, toolB]);
    await writeProject([toolAOverride]);
    const result = await loadToolWithSource("tool-a", projectRoot, fakeAgentDir);
    expect(result).toEqual({ tool: toolAOverride, source: "project" });
  });

  it("returns global tool when project config has different tools", async () => {
    await writeGlobal([toolA]);
    await writeProject([toolB]);
    const result = await loadToolWithSource("tool-a", projectRoot, fakeAgentDir);
    expect(result).toEqual({ tool: toolA, source: "global" });
  });
});

describe("removeFromConfig", () => {
  it("does nothing if the config file does not exist (ENOENT)", async () => {
    // Neither project nor global file exists — should not throw
    await expect(removeFromConfig("tool-a", "project", projectRoot, fakeAgentDir)).resolves.toBeUndefined();
  });

  it("removes a tool from the project config file", async () => {
    await writeProject([toolA, toolB]);
    await removeFromConfig("tool-a", "project", projectRoot, fakeAgentDir);
    const content = await readFile(path.join(projectRoot, ".pi", "armory.json"), "utf-8");
    const parsed = JSON.parse(content) as { tools: ArmoryTool[] };
    expect(parsed.tools).toHaveLength(1);
    expect(parsed.tools[0].name).toBe("tool-b");
  });

  it("removes a tool from the global config file", async () => {
    await writeGlobal([toolA, toolB]);
    await removeFromConfig("tool-b", "global", projectRoot, fakeAgentDir);
    const content = await readFile(path.join(fakeAgentDir, "armory.json"), "utf-8");
    const parsed = JSON.parse(content) as { tools: ArmoryTool[] };
    expect(parsed.tools).toHaveLength(1);
    expect(parsed.tools[0].name).toBe("tool-a");
  });

  it("preserves other tools when removing one", async () => {
    await writeProject([toolA, toolB]);
    await removeFromConfig("tool-a", "project", projectRoot, fakeAgentDir);
    const content = await readFile(path.join(projectRoot, ".pi", "armory.json"), "utf-8");
    const parsed = JSON.parse(content) as { tools: ArmoryTool[] };
    expect(parsed.tools).toEqual([toolB]);
  });

  it("does nothing if the tool is not in the file", async () => {
    await writeProject([toolB]);
    await removeFromConfig("tool-a", "project", projectRoot, fakeAgentDir);
    const content = await readFile(path.join(projectRoot, ".pi", "armory.json"), "utf-8");
    const parsed = JSON.parse(content) as { tools: ArmoryTool[] };
    expect(parsed.tools).toEqual([toolB]);
  });

  it("preserves draftModel when removing a tool", async () => {
    const dir = path.join(projectRoot, ".pi");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "armory.json"),
      `${JSON.stringify({ tools: [toolA, toolB], draftModel: "fast-model" }, null, 2)}\n`,
    );
    await removeFromConfig("tool-a", "project", projectRoot, fakeAgentDir);
    const content = await readFile(path.join(dir, "armory.json"), "utf-8");
    const parsed = JSON.parse(content) as { tools: ArmoryTool[]; draftModel?: string };
    expect(parsed.draftModel).toBe("fast-model");
    expect(parsed.tools).toEqual([toolB]);
  });
});

describe("schema validation", () => {
  it("ignores unknown top-level keys", async () => {
    await mkdir(fakeAgentDir, { recursive: true });
    await writeFile(path.join(fakeAgentDir, "armory.json"), JSON.stringify({ tools: [], unknownKey: true }, null, 2));
    const result = await loadConfig(projectRoot, fakeAgentDir);
    expect(result.tools).toEqual([]);
  });

  it("ignores unknown tool keys", async () => {
    await mkdir(fakeAgentDir, { recursive: true });
    await writeFile(
      path.join(fakeAgentDir, "armory.json"),
      JSON.stringify({ tools: [{ name: "t", command: "echo", description: "d", extra: true }] }, null, 2),
    );
    const result = await loadConfig(projectRoot, fakeAgentDir);
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe("t");
  });

  it("rejects tool with wrong field type", async () => {
    await mkdir(fakeAgentDir, { recursive: true });
    await writeFile(
      path.join(fakeAgentDir, "armory.json"),
      JSON.stringify({ tools: [{ name: 123, command: "echo", description: "d" }] }, null, 2),
    );
    const result = await loadConfig(projectRoot, fakeAgentDir);
    expect(result.tools).toEqual([]);
  });

  it("rejects tool missing required fields", async () => {
    await mkdir(fakeAgentDir, { recursive: true });
    await writeFile(path.join(fakeAgentDir, "armory.json"), JSON.stringify({ tools: [{ name: "t" }] }, null, 2));
    const result = await loadConfig(projectRoot, fakeAgentDir);
    expect(result.tools).toEqual([]);
  });

  it("accepts valid config with all optional fields", async () => {
    const tool = {
      name: "full",
      command: "echo full {{arg}}",
      description: "Full tool",
      requires_approval: true,
      guidelines: ["Be careful"],
      secrets: { API_KEY: "keychain:api-key" },
    };
    await writeGlobal([tool as ArmoryTool]);
    const result = await loadConfig(projectRoot, fakeAgentDir);
    expect(result.tools).toEqual([tool]);
  });
});
