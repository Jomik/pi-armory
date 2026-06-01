import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ArmoryTool } from "./config.js";
import { reviseDraftDefinition } from "./draft.js";
import type { ToolFormResult } from "./tool-form.js";

export interface PlaceholderInfo {
  name: string;
  variadic: boolean;
  optional: boolean;
  /** The flag string, e.g. `--verbose` or `-m`. Present only for flag placeholders. */
  flag?: string;
  /** True when the flag is boolean (no value param). */
  boolean?: true;
}

export function extractPlaceholders(command: string): string[] {
  return parsePlaceholders(command).map((p) => p.name);
}

export function parsePlaceholders(command: string): PlaceholderInfo[] {
  const seen = new Map<string, PlaceholderInfo>();

  // Flag placeholders: {{--flag}}, {{--flag?}}, {{--flag value}}, {{--flag value?}},
  //                    {{-f}}, {{-f?}}, {{-f value}}, {{-f value?}}
  const FLAG_RE = /\{\{(-{1,2}[\w-]+)(?:\s+([\w]+)(\?)?)?\s*(\?)?\}\}/g;
  for (const m of command.matchAll(FLAG_RE)) {
    const flagStr = m[1]; // e.g. "--verbose" or "-m"
    const valueParam = m[2]; // value word, e.g. "message", or undefined for boolean
    const valueOptMark = m[3]; // "?" when value word is optional
    const boolOptMark = m[4]; // "?" when boolean flag is optional

    if (valueParam) {
      // Flag+value: param name is the value word
      const name = valueParam;
      const optional = valueOptMark === "?";
      const existing = seen.get(name);
      if (existing) {
        if (existing.optional !== optional || existing.flag !== flagStr) {
          throw new Error(`Conflicting modifiers for placeholder: ${name}`);
        }
        continue;
      }
      seen.set(name, { name, variadic: false, optional, flag: flagStr });
    } else {
      // Boolean flag: param name is the flag stripped of leading dashes
      const name = flagStr.replace(/^-+/, "");
      const optional = boolOptMark === "?";
      const existing = seen.get(name);
      if (existing) {
        if (existing.optional !== optional || existing.flag !== flagStr) {
          throw new Error(`Conflicting modifiers for placeholder: ${name}`);
        }
        continue;
      }
      seen.set(name, { name, variadic: false, optional, flag: flagStr, boolean: true });
    }
  }

  // Regular placeholders: {{name}}, {{name?}}, {{...name}}, {{...name?}}
  const REGULAR_RE = /\{\{(\.\.\.)?([\w]+)(\?)?\}\}/g;
  for (const m of command.matchAll(REGULAR_RE)) {
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

export function formatParamValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${(value as unknown[]).map(String).join(", ")}]`;
  }
  return String(value ?? "");
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
