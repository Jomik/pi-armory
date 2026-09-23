import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import type { ArmoryConfig, ArmoryTool, EnvBinding } from "./schema.js";
import { ArmoryConfigSchema } from "./schema.js";

export type { ArmoryConfig, ArmoryTool, EnvBinding } from "./schema.js";
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
  try {
    validateConfig(parsed);
  } catch (err) {
    console.warn(`pi-armory: invalid config in ${filePath}: ${(err as Error).message}, ${onInvalid}`);
    return null;
  }
  return parsed as ArmoryConfig;
}

export type EnvSets = NonNullable<ArmoryConfig["envSets"]>;

/** Validate and assemble bindings without resolving values or changing the stored tool. */
export function validateEffectiveBindings(tool: ArmoryTool, envSets: EnvSets): Record<string, EnvBinding> {
  const bindings = new Map<string, EnvBinding>();
  const selected = new Set<string>();
  for (const name of tool.envFrom ?? []) {
    if (selected.has(name)) throw new Error(`tool ${tool.name}: repeated envFrom set ${name}`);
    selected.add(name);
    if (!Object.hasOwn(envSets, name)) throw new Error(`tool ${tool.name}: unknown envFrom set ${name}`);
    for (const [key, binding] of Object.entries(envSets[name])) {
      if (bindings.has(key)) throw new Error(`tool ${tool.name}: duplicate environment variable ${key}`);
      bindings.set(key, binding);
    }
  }
  for (const [key, binding] of Object.entries(tool.env ?? {})) {
    if (bindings.has(key)) throw new Error(`tool ${tool.name}: duplicate environment variable ${key}`);
    bindings.set(key, binding);
  }
  return Object.fromEntries(bindings);
}

function validateConfig(config: unknown): asserts config is ArmoryConfig {
  if (!Value.Check(ArmoryConfigSchema, config)) {
    const first = [...Value.Errors(ArmoryConfigSchema, config)][0];
    throw new Error(`${first?.instancePath || "/"}: ${first?.message ?? "schema mismatch"}`);
  }
  const names = new Set<string>();
  for (const tool of config.tools) {
    if (names.has(tool.name)) throw new Error(`duplicate tool name ${tool.name}`);
    names.add(tool.name);
    validateEffectiveBindings(tool, config.envSets ?? {});
  }
}

function resolveConfigPath(destination: "project" | "global", projectRoot: string, agentDir: string): string {
  return destination === "project" ? path.join(projectRoot, ".pi", "armory.json") : path.join(agentDir, "armory.json");
}

/**
 * Synchronously loads the tool names declared in <projectRoot>/.pi/armory.json.
 * Excludes global and session-only tools. Missing, invalid, or unreadable
 * project config returns [] rather than throwing.
 */
export function loadProjectToolNamesSync(projectRoot: string): string[] {
  const projectPath = path.join(projectRoot, ".pi", "armory.json");
  let content: string;
  try {
    content = readFileSync(projectPath, "utf-8");
  } catch {
    return [];
  }
  const config = parseToolsJson(content, projectPath, "ignoring");
  if (!config) return [];
  return config.tools.map((tool) => tool.name).sort((a, b) => a.localeCompare(b));
}

async function readConfigFile(filePath: string): Promise<ArmoryConfig | null> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch (err: unknown) {
    if (isEnoent(err)) return { tools: [] };
    throw err;
  }
  return parseToolsJson(content, filePath, "ignoring");
}

export async function loadToolInDestination(
  name: string,
  destination: PersistedToolSource,
  projectRoot: string,
  agentDir: string = getAgentDir(),
): Promise<ArmoryTool | null> {
  const filePath = resolveConfigPath(destination, projectRoot, agentDir);
  const config = await readConfigFile(filePath);
  if (!config) throw new Error(`Invalid config in ${filePath}; refusing to inspect its tools`);
  return config.tools.find((tool) => tool.name === name) ?? null;
}

export async function getDestinationEnvSets(
  destination: PersistedToolSource,
  projectRoot: string,
  agentDir: string = getAgentDir(),
): Promise<EnvSets> {
  const filePath = resolveConfigPath(destination, projectRoot, agentDir);
  const config = await readConfigFile(filePath);
  if (!config) throw new Error(`Invalid config in ${filePath}; refusing to use its env sets`);
  return config.envSets ?? {};
}

async function writeConfigFile(filePath: string, config: ArmoryConfig): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
}

export async function loadConfig(
  projectRoot: string,
  agentDir: string = getAgentDir(),
): Promise<{
  tools: ArmoryTool[];
  envSetsByTool?: Record<string, EnvSets>;
  draftModel?: string;
  disableBash: boolean;
}> {
  const globalPath = path.join(agentDir, "armory.json");
  const projectPath = path.join(projectRoot, ".pi", "armory.json");

  const [globalResult, projectResult] = await Promise.all([readConfigFile(globalPath), readConfigFile(projectPath)]);

  const merged = mergePersistedToolsWithSource(globalResult, projectResult);
  const draftModel = projectResult?.draftModel ?? globalResult?.draftModel;
  const disableBash = globalResult?.disableBash ?? true;

  return {
    tools: Array.from(merged.values())
      .map(({ tool }) => tool)
      .sort((a, b) => a.name.localeCompare(b.name)),
    envSetsByTool: Object.fromEntries(Array.from(merged, ([name, { envSets }]) => [name, envSets])),
    ...(draftModel !== undefined ? { draftModel } : {}),
    disableBash,
  };
}

function mergePersistedToolsWithSource(
  globalConfig: ArmoryConfig | null,
  projectConfig: ArmoryConfig | null,
): Map<string, { tool: ArmoryTool; source: PersistedToolSource; envSets: EnvSets }> {
  const merged = new Map<string, { tool: ArmoryTool; source: PersistedToolSource; envSets: EnvSets }>();
  for (const tool of globalConfig?.tools ?? []) {
    merged.set(tool.name, { tool, source: "global", envSets: globalConfig?.envSets ?? {} });
  }
  for (const tool of projectConfig?.tools ?? []) {
    merged.set(tool.name, { tool, source: "project", envSets: projectConfig?.envSets ?? {} });
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
  const merged = mergePersistedToolsWithSource(globalResult, projectResult);

  return Array.from(merged.values())
    .map(({ tool, source }) => ({ tool, source }))
    .sort((a, b) => a.tool.name.localeCompare(b.tool.name));
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
  const projectTool = projectResult?.tools.find((t) => t.name === name);
  if (projectTool) return { tool: projectTool, source: "project" };

  const globalTool = globalResult?.tools.find((t) => t.name === name);
  if (globalTool) return { tool: globalTool, source: "global" };

  return null;
}

export async function removeFromConfig(
  toolName: string,
  destination: "project" | "global",
  projectRoot: string,
  agentDir: string = getAgentDir(),
  expectedTool?: ArmoryTool,
): Promise<void> {
  const filePath = resolveConfigPath(destination, projectRoot, agentDir);
  const config = await readConfigFile(filePath);
  if (!config) throw new Error(`Invalid config in ${filePath}; refusing to modify it`);
  if (
    expectedTool !== undefined &&
    !isDeepStrictEqual(
      config.tools.find((t) => t.name === toolName),
      expectedTool,
    )
  ) {
    throw new Error(`Tool ${toolName} changed; reload before removing`);
  }
  const tools = config.tools.filter((t) => t.name !== toolName);
  if (tools.length === config.tools.length) return; // nothing to remove
  await writeConfigFile(filePath, { ...config, tools });
}

export async function saveConfig(
  tool: ArmoryTool,
  destination: "project" | "global",
  projectRoot: string,
  agentDir: string = getAgentDir(),
  expectedEnvSets?: EnvSets,
  createOnly = false,
): Promise<EnvSets> {
  const filePath = resolveConfigPath(destination, projectRoot, agentDir);
  const config = await readConfigFile(filePath);
  if (!config) throw new Error(`Invalid config in ${filePath}; refusing to modify it`);
  const envSets = config.envSets ?? {};
  if (expectedEnvSets !== undefined) {
    for (const name of tool.envFrom ?? []) {
      if (
        !Object.hasOwn(expectedEnvSets, name) ||
        !Object.hasOwn(envSets, name) ||
        !isDeepStrictEqual(expectedEnvSets[name], envSets[name])
      ) {
        throw new Error("Selected env set changed; reload before saving");
      }
    }
  }
  const tools = [...config.tools];
  const idx = tools.findIndex((t) => t.name === tool.name);
  if (idx >= 0) {
    if (createOnly) throw new Error(`Tool ${tool.name} already exists; reload before saving`);
    tools[idx] = tool;
  } else {
    tools.push(tool);
  }
  const updated = { ...config, tools };
  validateConfig(updated);
  await writeConfigFile(filePath, updated);
  return envSets;
}
