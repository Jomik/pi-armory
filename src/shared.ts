import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ArmoryTool } from "./config.js";
import { reviseDraftDefinition } from "./draft.js";
import type { ToolFormResult } from "./tool-form.js";

export interface PlaceholderInfo {
  name: string;
  variadic: boolean;
  optional: boolean;
}

export function extractPlaceholders(command: string): string[] {
  return parsePlaceholders(command).map((p) => p.name);
}

export function parsePlaceholders(command: string): PlaceholderInfo[] {
  const matches = command.matchAll(/\{\{(\.\.\.)?([\w]+)(\?)?\}\}/g);
  const seen = new Map<string, PlaceholderInfo>();
  for (const m of matches) {
    const name = m[2];
    const variadic = m[1] === "...";
    const optional = m[3] === "?";
    const existing = seen.get(name);
    if (existing) {
      if (existing.variadic !== variadic || existing.optional !== optional) {
        throw new Error(`Conflicting modifiers for placeholder: ${name}`);
      }
      continue;
    }
    seen.set(name, { name, variadic, optional });
  }
  return [...seen.values()];
}

export function resolveModel(registry: ModelRegistry, name: string): Model<Api> | undefined {
  const colonIdx = name.indexOf(":");
  if (colonIdx <= 0) return undefined;
  const provider = name.slice(0, colonIdx);
  const modelId = name.slice(colonIdx + 1);
  return registry.find(provider, modelId);
}

export function makeRedraftCallback(
  ctx: { modelRegistry: ModelRegistry },
  model: Model<Api>,
): (current: ToolFormResult, instruction: string) => Promise<ToolFormResult | null> {
  return async (current, instruction) => {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) return null;
    const revised = await reviseDraftDefinition(
      model,
      { apiKey: auth.apiKey ?? "", ...(auth.headers ? { headers: auth.headers } : {}) },
      {
        current: {
          name: current.name,
          command: current.command,
          description: current.description,
          guidelines: current.guidelines,
          requires_approval: current.requiresApproval,
          destination: current.destination,
        },
        instruction,
      },
      undefined,
    );
    return {
      name: revised.name,
      command: revised.command,
      description: revised.description,
      guidelines: revised.guidelines,
      requiresApproval: revised.requires_approval,
      destination: revised.destination,
    };
  };
}

export function buildToolFromResult(result: ToolFormResult, opts?: Pick<ArmoryTool, "env" | "secrets">): ArmoryTool {
  return {
    name: result.name,
    command: result.command,
    description: result.description,
    ...(result.requiresApproval ? { requires_approval: true } : {}),
    ...(result.guidelines.length > 0 ? { guidelines: result.guidelines } : {}),
    ...(opts?.env ? { env: opts.env } : {}),
    ...(opts?.secrets ? { secrets: opts.secrets } : {}),
  };
}
