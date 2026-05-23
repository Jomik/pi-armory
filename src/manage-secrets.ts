import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ArmoryTool } from "./config.js";
import { loadToolWithSource, removeFromConfig, saveConfig } from "./config.js";
import { reviseDraftDefinition } from "./draft.js";
import { extractPlaceholders } from "./request-tool.js";
import { SecretsPanel } from "./secrets-panel.js";
import { type ToolFormResult, toolFormPanel } from "./tool-form.js";

export interface ArmoryCommandDeps {
  tools: ArmoryTool[];
  projectRoot: string;
  draftModelName?: string;
}

export function registerArmoryCommand(pi: ExtensionAPI, deps: ArmoryCommandDeps): void {
  pi.registerCommand("armory", {
    description: "Manage armory: /armory secrets | /armory edit [name]",
    getArgumentCompletions(prefix) {
      const items = [
        { value: "secrets", label: "secrets", description: "Manage keychain secrets" },
        { value: "edit", label: "edit", description: "Edit an existing tool" },
      ];
      // For "edit " prefix, complete with tool names
      if (prefix.startsWith("edit ")) {
        const namePrefix = prefix.slice(5).toLowerCase();
        return deps.tools
          .map((t) => ({ value: `edit ${t.name}`, label: t.name, description: t.description }))
          .filter((i) => i.label.startsWith(namePrefix));
      }
      if (!prefix) return items;
      const lower = prefix.toLowerCase();
      const filtered = items.filter((i) => i.value.startsWith(lower));
      return filtered.length > 0 ? filtered : null;
    },
    async handler(args, ctx) {
      const trimmed = args.trim();
      const sub = trimmed.toLowerCase();
      if (sub === "edit" || sub.startsWith("edit ")) {
        const toolName = trimmed.slice(4).trim() || undefined;
        await handleEdit(ctx, deps, toolName);
      } else if (sub === "secrets") {
        await handleSecrets(ctx, deps.tools);
      } else {
        ctx.ui.notify(`Unknown: ${sub}. Available: secrets, edit`, "error");
      }
    },
  });
}

type Ctx = Pick<ExtensionCommandContext, "ui">;

function getAccounts(tools: ArmoryTool[]): string[] {
  const accounts = new Set<string>();
  for (const tool of tools) {
    if (tool.secrets) {
      for (const account of Object.values(tool.secrets)) {
        accounts.add(account);
      }
    }
  }
  return [...accounts].sort();
}

async function handleSecrets(ctx: Ctx, tools: ArmoryTool[]): Promise<void> {
  const accounts = getAccounts(tools);
  await ctx.ui.custom<null>(
    (tui, theme, _keybindings, done) =>
      new SecretsPanel({
        tui,
        theme,
        done,
        notify: (msg, type) => ctx.ui.notify(msg, type),
        accounts,
      }),
    { overlay: true, overlayOptions: { anchor: "center", width: 50, maxHeight: "60%" } },
  );
}

async function handleEdit(ctx: ExtensionCommandContext, deps: ArmoryCommandDeps, toolName?: string): Promise<void> {
  // If no name, show a picker
  let selectedName = toolName;
  if (!selectedName) {
    if (deps.tools.length === 0) {
      ctx.ui.notify("No tools registered", "error");
      return;
    }
    selectedName = await ctx.ui.select(
      "Select tool to edit",
      deps.tools.map((t) => t.name),
    );
    if (!selectedName) return;
  }

  // Load tool with source info
  const found = await loadToolWithSource(selectedName, deps.projectRoot);
  if (!found) {
    ctx.ui.notify(`Tool '${selectedName}' not found`, "error");
    return;
  }

  const { tool, source } = found;

  // Resolve draft model — same pattern as request-tool.ts
  let draftModel: Model<Api> | undefined;
  if (deps.draftModelName) {
    const colonIdx = deps.draftModelName.indexOf(":");
    if (colonIdx > 0) {
      const provider = deps.draftModelName.slice(0, colonIdx);
      const modelId = deps.draftModelName.slice(colonIdx + 1);
      draftModel = ctx.modelRegistry.find(provider, modelId);
    }
  }
  if (!draftModel) {
    draftModel = ctx.model as Model<Api> | undefined;
  }

  // Show the form pre-populated with existing tool values
  const dm = draftModel;
  const result = await ctx.ui.custom<ToolFormResult | null>((tui, theme, _keybindings, done) => {
    return toolFormPanel(
      tui,
      theme,
      done,
      {
        title: "Edit Tool",
        name: tool.name,
        command: tool.command,
        description: tool.description,
        guidelines: tool.guidelines ?? [],
        requiresApproval: tool.requires_approval ?? false,
        destination: source,
      },
      {
        onRedraft: dm
          ? async (current, instruction) => {
              const auth = await ctx.modelRegistry.getApiKeyAndHeaders(dm);
              if (!auth.ok) return null;
              // Build adapted parameters for DraftOutput shape
              const adaptedParams: Record<string, { description: string }> = {};
              for (const [key, val] of Object.entries(tool.parameters ?? {})) {
                adaptedParams[key] = { description: val.description ?? key };
              }
              const revised = await reviseDraftDefinition(
                dm,
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
                ctx.signal,
              );
              return {
                name: revised.name,
                command: revised.command,
                description: revised.description,
                guidelines: revised.guidelines,
                requiresApproval: revised.requires_approval,
                destination: revised.destination,
              };
            }
          : undefined,
      },
    );
  });

  if (!result) return; // user rejected

  // Build updated tool from result
  const placeholders = extractPlaceholders(result.command);
  const updatedTool: ArmoryTool = {
    name: result.name,
    command: result.command,
    description: result.description,
    ...(result.requiresApproval ? { requires_approval: true } : {}),
    ...(result.guidelines.length > 0 ? { guidelines: result.guidelines } : {}),
    ...(placeholders.length > 0
      ? {
          parameters: Object.fromEntries(
            placeholders.map((p) => [p, { type: "string" as const, description: tool.parameters?.[p]?.description }]),
          ),
        }
      : {}),
    // Preserve secrets if they existed
    ...(tool.secrets ? { secrets: tool.secrets } : {}),
  };

  // Save to new (or same) destination
  await saveConfig(updatedTool, result.destination, deps.projectRoot);

  // Remove old entry if destination or name changed (saveConfig upserts by name,
  // so we need to clean up the old name/location when either changes)
  if (result.destination !== source || result.name !== tool.name) {
    await removeFromConfig(tool.name, source, deps.projectRoot);
  }

  ctx.ui.notify(`Tool '${updatedTool.name}' updated`, "info");
}
