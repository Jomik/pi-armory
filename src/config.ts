import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import type { ArmoryConfig, ArmoryTool } from "./schema.js";
import { ArmoryConfigSchema } from "./schema.js";

export type { ArmoryConfig, ArmoryTool } from "./schema.js";
export type PersistedToolSource = "project" | "global";
export type ToolSource = PersistedToolSource | "session";

function isEnoent(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as { code: unknown }).code === "ENOENT";
}

function parseToolsJson(content: string, filePath: string, onInvalid: string): ArmoryConfig | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    console.warn(`pi-armory: invalid JSON in ${filePath}, ${onInvalid}`);
    return null;
  }
  if (!Value.Check(ArmoryConfigSchema, parsed)) {
    const errors = [...Value.Errors(ArmoryConfigSchema, parsed)];
    const first = errors[0];
    console.warn(
      `pi-armory: invalid config in ${filePath}${first ? `: ${first.instancePath || "/"}: ${first.message}` : ""}, ${onInvalid}`,
    );
    return null;
  }
  return parsed;
}

function resolveConfigPath(destination: "project" | "global", projectRoot: string, agentDir: string): string {
  return destination === "project" ? path.join(projectRoot, ".pi", "armory.json") : path.join(agentDir, "armory.json");
}

async function readConfigFile(filePath: string): Promise<ArmoryConfig> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch (err: unknown) {
    if (isEnoent(err)) return { tools: [] };
    throw err;
  }
  return parseToolsJson(content, filePath, "ignoring") ?? { tools: [] };
}

async function writeConfigFile(filePath: string, config: ArmoryConfig): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

export async function loadConfig(
  projectRoot: string,
  agentDir: string = getAgentDir(),
): Promise<{ tools: ArmoryTool[]; draftModel?: string; disableBash: boolean }> {
  const globalPath = path.join(agentDir, "armory.json");
  const projectPath = path.join(projectRoot, ".pi", "armory.json");

  const [globalResult, projectResult] = await Promise.all([readConfigFile(globalPath), readConfigFile(projectPath)]);

  const merged = mergePersistedToolsWithSource(globalResult.tools, projectResult.tools);
  const draftModel = projectResult.draftModel ?? globalResult.draftModel;
  const disableBash = globalResult.disableBash ?? true;

  return {
    tools: Array.from(merged.values())
      .map(({ tool }) => tool)
      .sort((a, b) => a.name.localeCompare(b.name)),
    ...(draftModel !== undefined ? { draftModel } : {}),
    disableBash,
  };
}

function mergePersistedToolsWithSource(
  globalTools: ArmoryTool[],
  projectTools: ArmoryTool[],
): Map<string, { tool: ArmoryTool; source: PersistedToolSource }> {
  const merged = new Map<string, { tool: ArmoryTool; source: PersistedToolSource }>();
  for (const tool of globalTools) {
    merged.set(tool.name, { tool, source: "global" });
  }
  for (const tool of projectTools) {
    merged.set(tool.name, { tool, source: "project" });
  }
  return merged;
}

export async function loadToolsWithSource(
  projectRoot: string,
  agentDir: string = getAgentDir(),
): Promise<Array<{ tool: ArmoryTool; source: PersistedToolSource }>> {
  const globalPath = path.join(agentDir, "armory.json");
  const projectPath = path.join(projectRoot, ".pi", "armory.json");

  const [globalResult, projectResult] = await Promise.all([readConfigFile(globalPath), readConfigFile(projectPath)]);
  const merged = mergePersistedToolsWithSource(globalResult.tools, projectResult.tools);

  return Array.from(merged.values()).sort((a, b) => a.tool.name.localeCompare(b.tool.name));
}

export async function loadToolWithSource(
  name: string,
  projectRoot: string,
  agentDir: string = getAgentDir(),
): Promise<{ tool: ArmoryTool; source: "project" | "global" } | null> {
  const globalPath = path.join(agentDir, "armory.json");
  const projectPath = path.join(projectRoot, ".pi", "armory.json");

  const [globalResult, projectResult] = await Promise.all([readConfigFile(globalPath), readConfigFile(projectPath)]);

  // Project overrides global
  const projectTool = projectResult.tools.find((t) => t.name === name);
  if (projectTool) return { tool: projectTool, source: "project" };

  const globalTool = globalResult.tools.find((t) => t.name === name);
  if (globalTool) return { tool: globalTool, source: "global" };

  return null;
}

export async function removeFromConfig(
  toolName: string,
  destination: "project" | "global",
  projectRoot: string,
  agentDir: string = getAgentDir(),
): Promise<void> {
  const filePath = resolveConfigPath(destination, projectRoot, agentDir);
  const config = await readConfigFile(filePath);
  const tools = config.tools.filter((t) => t.name !== toolName);
  if (tools.length === config.tools.length) return; // nothing to remove
  await writeConfigFile(filePath, { ...config, tools });
}

export async function saveConfig(
  tool: ArmoryTool,
  destination: "project" | "global",
  projectRoot: string,
  agentDir: string = getAgentDir(),
): Promise<void> {
  const filePath = resolveConfigPath(destination, projectRoot, agentDir);
  const config = await readConfigFile(filePath);
  const tools = [...config.tools];
  const idx = tools.findIndex((t) => t.name === tool.name);
  if (idx >= 0) {
    tools[idx] = tool;
  } else {
    tools.push(tool);
  }
  await writeConfigFile(filePath, { ...config, tools });
}
