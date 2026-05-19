import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function isEnoent(err: unknown): boolean {
  return err instanceof Error && "code" in err && (err as { code: unknown }).code === "ENOENT";
}

function parseToolsJson(content: string, filePath: string, onInvalid: string): ArmoryTool[] | null {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      Array.isArray((parsed as ArmoryConfig).tools)
    ) {
      return (parsed as ArmoryConfig).tools;
    }
    console.warn(`pi-armory: invalid config in ${filePath}, ${onInvalid}`);
    return null;
  } catch {
    console.warn(`pi-armory: invalid JSON in ${filePath}, ${onInvalid}`);
    return null;
  }
}

interface ArmoryConfig {
  tools: ArmoryTool[];
}

export interface ArmoryTool {
  name: string;
  command: string;
  description: string;
  requires_approval?: boolean;
  guidelines?: string[];
}

async function readToolsFile(filePath: string): Promise<ArmoryTool[]> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch (err: unknown) {
    if (isEnoent(err)) {
      return [];
    }
    throw err;
  }

  return parseToolsJson(content, filePath, "ignoring") ?? [];
}

export async function loadConfig(projectRoot: string, homedir: string = os.homedir()): Promise<ArmoryTool[]> {
  const globalPath = path.join(homedir, ".pi", "agent", "armory.json");
  const projectPath = path.join(projectRoot, ".pi", "armory.json");

  const [globalTools, projectTools] = await Promise.all([readToolsFile(globalPath), readToolsFile(projectPath)]);

  const merged = new Map<string, ArmoryTool>();
  for (const tool of globalTools) {
    merged.set(tool.name, tool);
  }
  for (const tool of projectTools) {
    merged.set(tool.name, tool);
  }

  return Array.from(merged.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export async function saveConfig(
  tool: ArmoryTool,
  destination: "project" | "global",
  projectRoot: string,
  homedir: string = os.homedir(),
): Promise<void> {
  const filePath =
    destination === "project"
      ? path.join(projectRoot, ".pi", "armory.json")
      : path.join(homedir, ".pi", "agent", "armory.json");

  let tools: ArmoryTool[];

  try {
    const content = await readFile(filePath, "utf-8");
    tools = parseToolsJson(content, filePath, "overwriting") ?? [];
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

  await writeFile(filePath, `${JSON.stringify({ tools }, null, 2)}\n`, "utf-8");
}
