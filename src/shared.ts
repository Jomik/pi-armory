import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionUIContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ArmoryTool } from "./config.js";
import type { DraftInput } from "./draft.js";
import { reviseDraftDefinition } from "./draft.js";
import { detectRepositoryType, toolConditionMatches } from "./repository.js";
import {
  type ToolFormCallbacks,
  type ToolFormRejection,
  type ToolFormResult,
  type ToolFormState,
  toolFormPanel,
} from "./tool-form.js";

export {
  type BooleanFlagPlaceholder,
  extractPlaceholders,
  FLAG_PLACEHOLDER_RE,
  type PlaceholderInfo,
  parsePlaceholders,
  type RegularPlaceholder,
  type ValueFlagPlaceholder,
} from "./placeholders.js";

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
  originalRequest?: DraftInput,
): (current: ToolFormResult, instruction: string) => Promise<ToolFormResult | null> {
  return async (current, instruction) => {
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) return null;
    const revised = await reviseDraftDefinition(
      model,
      auth,
      {
        current: {
          name: current.name,
          command: current.command,
          description: current.description,
          guidelines: current.guidelines,
          requires_approval: current.requiresApproval,
          destination: current.destination,
          ...(current.when ? { when: current.when } : {}),
        },
        instruction,
        originalRequest,
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
      when: revised.when,
    };
  };
}

export function formatParamValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${(value as unknown[]).map(String).join(", ")}]`;
  }
  return String(value ?? "");
}

export function buildToolFromResult(result: ToolFormResult, opts?: Pick<ArmoryTool, "env" | "envFrom">): ArmoryTool {
  return {
    name: result.name,
    command: result.command,
    description: result.description,
    ...(result.requiresApproval ? { requires_approval: true } : {}),
    ...(result.guidelines.length > 0 ? { guidelines: result.guidelines } : {}),
    ...(opts?.env ? { env: opts.env } : {}),
    ...(opts?.envFrom ? { envFrom: opts.envFrom } : {}),
    ...(result.when ? { when: result.when } : {}),
  };
}

/**
 * Synchronizes `tool`'s active-tool membership for the current session with its `when`
 * condition at `cwd`: active (added) when the condition matches or is unconditional,
 * inactive (removed) when it is mismatched. Only ever adds or removes this tool's name;
 * all other active-tool choices are left untouched.
 */
export function syncToolCondition(
  pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">,
  cwd: string,
  tool: ArmoryTool,
): void {
  const active = pi.getActiveTools();
  const matches = !tool.when || toolConditionMatches(tool.when, detectRepositoryType(cwd));
  const isActive = active.includes(tool.name);
  if (matches && !isActive) {
    pi.setActiveTools([...active, tool.name]);
  } else if (!matches && isActive) {
    pi.setActiveTools(active.filter((name) => name !== tool.name));
  }
}

interface ShowToolEditorContext {
  modelRegistry: ModelRegistry;
  model?: unknown;
  ui: Pick<ExtensionUIContext, "custom">;
}

export async function showToolEditor(
  ctx: ShowToolEditorContext,
  initialState: ToolFormState,
  draftModelName?: string,
  originalRequest?: DraftInput,
): Promise<ToolFormResult | ToolFormRejection> {
  let draftModel: Model<Api> | undefined;
  if (draftModelName) {
    draftModel = resolveModel(ctx.modelRegistry, draftModelName);
  }
  if (!draftModel) {
    draftModel = ctx.model as Model<Api> | undefined;
  }

  const dm = draftModel;
  return ctx.ui.custom<ToolFormResult | ToolFormRejection>((tui, theme, _keybindings, done) => {
    const callbacks: ToolFormCallbacks = {
      onRedraft: dm ? makeRedraftCallback(ctx, dm, originalRequest) : undefined,
    };
    return toolFormPanel(tui, theme, done, initialState, callbacks);
  });
}
