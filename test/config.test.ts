import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ArmoryTool } from "../src/config.js";
import { loadConfig, saveConfig } from "../src/config.js";

let tmpDir: string;
let fakeHome: string;
let projectRoot: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "pi-armory-test-"));
  fakeHome = path.join(tmpDir, "home");
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
  const dir = path.join(fakeHome, ".pi", "agent");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "armory.json"), `${JSON.stringify({ tools }, null, 2)}\n`);
}

async function writeProject(tools: ArmoryTool[]) {
  const dir = path.join(projectRoot, ".pi");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "armory.json"), `${JSON.stringify({ tools }, null, 2)}\n`);
}

describe("loadConfig", () => {
  it("returns [] when no files exist", async () => {
    const result = await loadConfig(projectRoot, fakeHome);
    expect(result).toEqual([]);
  });

  it("returns global tools when only global file exists", async () => {
    await writeGlobal([toolA, toolB]);
    const result = await loadConfig(projectRoot, fakeHome);
    expect(result).toEqual([toolA, toolB]);
  });

  it("returns project tools when only project file exists", async () => {
    await writeProject([toolA]);
    const result = await loadConfig(projectRoot, fakeHome);
    expect(result).toEqual([toolA]);
  });

  it("merges global and project tools, project overrides by name", async () => {
    await writeGlobal([toolA, toolB]);
    await writeProject([toolAOverride]);
    const result = await loadConfig(projectRoot, fakeHome);
    expect(result).toHaveLength(2);
    expect(result.find((t) => t.name === "tool-a")).toEqual(toolAOverride);
    expect(result.find((t) => t.name === "tool-b")).toEqual(toolB);
  });

  it("returns [] and does not throw on invalid global JSON", async () => {
    const dir = path.join(fakeHome, ".pi", "agent");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "armory.json"), "not-valid-json");
    const result = await loadConfig(projectRoot, fakeHome);
    expect(result).toEqual([]);
  });

  it("returns [] and does not throw on invalid project JSON", async () => {
    const dir = path.join(projectRoot, ".pi");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "armory.json"), "{bad json");
    const result = await loadConfig(projectRoot, fakeHome);
    expect(result).toEqual([]);
  });
});

describe("saveConfig", () => {
  it("creates project file if it does not exist", async () => {
    await saveConfig(toolA, "project", projectRoot, fakeHome);
    const content = await readFile(path.join(projectRoot, ".pi", "armory.json"), "utf-8");
    expect(JSON.parse(content)).toEqual({ tools: [toolA] });
  });

  it("creates global file if it does not exist", async () => {
    await saveConfig(toolA, "global", projectRoot, fakeHome);
    const content = await readFile(path.join(fakeHome, ".pi", "agent", "armory.json"), "utf-8");
    expect(JSON.parse(content)).toEqual({ tools: [toolA] });
  });

  it("appends new tool to existing project file", async () => {
    await writeProject([toolA]);
    await saveConfig(toolB, "project", projectRoot, fakeHome);
    const content = await readFile(path.join(projectRoot, ".pi", "armory.json"), "utf-8");
    expect(JSON.parse(content)).toEqual({ tools: [toolA, toolB] });
  });

  it("replaces existing tool by name in project file", async () => {
    await writeProject([toolA, toolB]);
    await saveConfig(toolAOverride, "project", projectRoot, fakeHome);
    const content = await readFile(path.join(projectRoot, ".pi", "armory.json"), "utf-8");
    const parsed = (JSON.parse(content) as { tools: ArmoryTool[] }).tools;
    expect(parsed).toHaveLength(2);
    expect(parsed.find((t) => t.name === "tool-a")).toEqual(toolAOverride);
    expect(parsed.find((t) => t.name === "tool-b")).toEqual(toolB);
  });

  it("writes pretty-printed JSON with trailing newline", async () => {
    await saveConfig(toolA, "project", projectRoot, fakeHome);
    const content = await readFile(path.join(projectRoot, ".pi", "armory.json"), "utf-8");
    expect(content.endsWith("\n")).toBe(true);
    expect(content).toBe(`${JSON.stringify({ tools: [toolA] }, null, 2)}\n`);
  });
});
