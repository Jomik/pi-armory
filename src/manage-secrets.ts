import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ArmoryTool } from "./config.js";
import { loadToolWithSource, removeFromConfig, saveConfig } from "./config.js";
import { approvalRegistry, registerArmoryTool } from "./register-tool.js";
import { SecretsPanel } from "./secrets-panel.js";
import { buildToolFromResult, makeRedraftCallback, resolveModel } from "./shared.js";
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
        await handleEdit(pi, ctx, deps, toolName);
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

async function handleEdit(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  deps: ArmoryCommandDeps,
  toolName?: string,
): Promise<void> {
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
    draftModel = resolveModel(ctx.modelRegistry, deps.draftModelName);
  }
  if (!draftModel) {
    draftModel = ctx.model as Model<Api> | undefined;
  }

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
        onRedraft: dm ? makeRedraftCallback(ctx, dm) : undefined,
      },
    );
  });

  if (!result) return; // user rejected

  const parameterDescriptions = tool.parameters
    ? Object.fromEntries(Object.entries(tool.parameters).map(([k, v]) => [k, v.description]))
    : undefined;
  const updatedTool = buildToolFromResult(result, { parameterDescriptions, secrets: tool.secrets });

  // Save to new (or same) destination
  await saveConfig(updatedTool, result.destination, deps.projectRoot);

  // Remove old entry if destination or name changed (saveConfig upserts by name,
  // so we need to clean up the old name/location when either changes)
  if (result.destination !== source || result.name !== tool.name) {
    await removeFromConfig(tool.name, source, deps.projectRoot);
  }

  approvalRegistry.delete(tool.name);
  registerArmoryTool(pi, updatedTool);
  const oldIdx = deps.tools.findIndex((t) => t.name === tool.name);
  if (oldIdx !== -1) {
    deps.tools.splice(oldIdx, 1);
  }
  deps.tools.push(updatedTool);
  // Deactivate old tool name on rename — pi has no unregisterTool API,
  // but we can remove it from the active set so the agent won't invoke it.
  if (updatedTool.name !== tool.name) {
    const active = pi.getActiveTools().filter((name) => name !== tool.name);
    pi.setActiveTools(active);
  }
  ctx.ui.notify(`Tool '${updatedTool.name}' updated`, "info");
}
