import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

function isEnoent(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as { code: unknown }).code === "ENOENT";
}

function parseToolsJson(
  content: string,
  filePath: string,
  onInvalid: string,
): { tools: ArmoryTool[]; draftModel?: string; disableBash?: boolean } | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      Array.isArray((parsed as ArmoryConfig).tools)
    ) {
      const cfg = parsed as ArmoryConfig;
      return {
        tools: cfg.tools,
        ...(cfg.draftModel !== undefined ? { draftModel: cfg.draftModel } : {}),
        ...(cfg.disableBash !== undefined ? { disableBash: cfg.disableBash } : {}),
      };
    }
    console.warn(`pi-armory: invalid config in ${filePath}, ${onInvalid}`);
    return null;
  } catch {
    console.warn(`pi-armory: invalid JSON in ${filePath}, ${onInvalid}`);
    return null;
  }
}

interface ArmoryConfig {
  draftModel?: string;
  disableBash?: boolean;
  tools: ArmoryTool[];
}

export interface ArmoryTool {
  name: string;
  command: string;
  description: string;
  requires_approval?: boolean;
  guidelines?: string[];
  parameters?: Record<string, { type: "string"; description?: string }>;
  secrets?: Record<string, string>;
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
