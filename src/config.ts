import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import type { ArmoryConfig, ArmoryTool } from "./schema.js";
import { ArmoryConfigSchema } from "./schema.js";

export type { ArmoryConfig, ArmoryTool } from "./schema.js";

function isEnoent(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as { code: unknown }).code === "ENOENT";
}

function parseToolsJson(
  content: string,
  filePath: string,
  onInvalid: string,
): { tools: ArmoryTool[]; draftModel?: string; disableBash?: boolean } | null {
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
  return {
    tools: parsed.tools,
    ...(parsed.draftModel !== undefined ? { draftModel: parsed.draftModel } : {}),
    ...(parsed.disableBash !== undefined ? { disableBash: parsed.disableBash } : {}),
  };
}

async function readToolsFile(
  filePath: string,
): Promise<{ tools: ArmoryTool[]; draftModel?: string; disableBash?: boolean }> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch (err: unknown) {
    if (isEnoent(err)) {
      return { tools: [] };
    }
    throw err;
  }

  return parseToolsJson(content, filePath, "ignoring") ?? { tools: [] };
}

export async function loadConfig(
  projectRoot: string,
  agentDir: string = getAgentDir(),
): Promise<{ tools: ArmoryTool[]; draftModel?: string; disableBash: boolean }> {
  const globalPath = path.join(agentDir, "armory.json");
  const projectPath = path.join(projectRoot, ".pi", "armory.json");

  const [globalResult, projectResult] = await Promise.all([readToolsFile(globalPath), readToolsFile(projectPath)]);

  const merged = new Map<string, ArmoryTool>();
  for (const tool of globalResult.tools) {
    merged.set(tool.name, tool);
  }
  for (const tool of projectResult.tools) {
    merged.set(tool.name, tool);
  }

  const draftModel = projectResult.draftModel ?? globalResult.draftModel;
  const disableBash = globalResult.disableBash ?? true;

  return {
    tools: Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name)),
    ...(draftModel !== undefined ? { draftModel } : {}),
    disableBash,
  };
}

export async function loadToolWithSource(
  name: string,
  projectRoot: string,
  agentDir: string = getAgentDir(),
): Promise<{ tool: ArmoryTool; source: "project" | "global" } | null> {
  const globalPath = path.join(agentDir, "armory.json");
  const projectPath = path.join(projectRoot, ".pi", "armory.json");

  const [globalResult, projectResult] = await Promise.all([readToolsFile(globalPath), readToolsFile(projectPath)]);

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
  const filePath =
    destination === "project" ? path.join(projectRoot, ".pi", "armory.json") : path.join(agentDir, "armory.json");

  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch (err: unknown) {
    if (isEnoent(err)) return;
    throw err;
  }

  const existing = parseToolsJson(content, filePath, "ignoring");
  if (!existing) return;

  const tools = existing.tools.filter((t) => t.name !== toolName);
  const { tools: _discarded, ...rest } = existing;
  await writeFile(filePath, `${JSON.stringify({ ...rest, tools }, null, 2)}\n`, "utf-8");
}

export async function saveConfig(
  tool: ArmoryTool,
  destination: "project" | "global",
  projectRoot: string,
  agentDir: string = getAgentDir(),
): Promise<void> {
  const filePath =
    destination === "project" ? path.join(projectRoot, ".pi", "armory.json") : path.join(agentDir, "armory.json");

  let tools: ArmoryTool[];

  let rest: Omit<ArmoryConfig, "tools"> = {};

  try {
    const content = await readFile(filePath, "utf-8");
    const existing = parseToolsJson(content, filePath, "overwriting");
    tools = existing?.tools ?? [];
    const { tools: _discarded, ...parsedRest } = existing ?? {};
    rest = parsedRest;
  } catch (err: unknown) {
    if (isEnoent(err)) {
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, `${JSON.stringify({ tools: [tool] }, null, 2)}\n`, "utf-8");
      return;
    }
    throw err;
  }

  const idx = tools.findIndex((t) => t.name === tool.name);
  if (idx >= 0) {
    tools[idx] = tool;
  } else {
    tools.push(tool);
  }

  await writeFile(filePath, `${JSON.stringify({ ...rest, tools }, null, 2)}\n`, "utf-8");
}
