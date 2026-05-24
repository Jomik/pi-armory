import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ArmoryTool } from "./config.js";
import { reviseDraftDefinition } from "./draft.js";
import type { ToolFormResult } from "./tool-form.js";

export function extractPlaceholders(command: string): string[] {
  const matches = command.matchAll(/\{\{(\w+)\}\}/g);
  return [...new Set([...matches].map((m) => m[1]))];
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
    const placeholders = extractPlaceholders(current.command);
    const adaptedParams: Record<string, { description: string }> = {};
    for (const p of placeholders) {
      adaptedParams[p] = { description: p };
    }
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
          parameters: adaptedParams,
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

export function buildToolFromResult(
  result: ToolFormResult,
  opts?: {
    parameterDescriptions?: Record<string, string | undefined>;
    secrets?: Record<string, string>;
  },
): ArmoryTool {
  const placeholders = extractPlaceholders(result.command);
  const descriptions = opts?.parameterDescriptions;
  return {
    name: result.name,
    command: result.command,
    description: result.description,
    ...(result.requiresApproval ? { requires_approval: true } : {}),
    ...(result.guidelines.length > 0 ? { guidelines: result.guidelines } : {}),
    ...(placeholders.length > 0
      ? {
          parameters: Object.fromEntries(
            placeholders.map((p) => [p, { type: "string" as const, description: descriptions?.[p] }]),
          ),
        }
      : {}),
    ...(opts?.secrets ? { secrets: opts.secrets } : {}),
  };
}
