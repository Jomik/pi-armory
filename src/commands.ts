import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ArmoryTool, ToolSource } from "./config.js";
import {
  getDestinationEnvSets,
  loadToolInDestination,
  loadToolsWithSource,
  loadToolWithSource,
  removeFromConfig,
  saveConfig,
} from "./config.js";
import { handleOnboard } from "./onboard.js";
import { approvalRegistry, registerArmoryTool, sessionRegistry, toolRegistry } from "./register-tool.js";
import { normalizeName, RESERVED_NAMES, VALID_NAME } from "./request-tool.js";
import { buildToolFromResult, showToolEditor, syncToolCondition } from "./shared.js";

export interface ArmoryCommandDeps {
  tools: ArmoryTool[];
  projectRoot: string;
  draftModelName?: string;
}

export function registerArmoryCommand(pi: ExtensionAPI, deps: ArmoryCommandDeps): void {
  pi.registerCommand("armory", {
    description: "Manage armory: /armory edit [name] | /armory delete [name] | /armory onboard",
    getArgumentCompletions(prefix) {
      const items = [
        { value: "edit", label: "edit", description: "Edit an existing tool" },
        { value: "delete", label: "delete", description: "Delete a tool" },
        { value: "onboard", label: "onboard", description: "Bootstrap project tools with AI assistance" },
      ];

      const allTools = allEditableTools(deps);

      // For "edit " prefix, complete with tool names
      if (prefix.startsWith("edit ")) {
        const namePrefix = prefix.slice(5).toLowerCase();
        return allTools
          .map((t) => ({ value: `edit ${t.name}`, label: t.name, description: t.description }))
          .filter((i) => i.label.startsWith(namePrefix));
      }

      // For "delete " prefix, complete with tool names
      if (prefix.startsWith("delete ")) {
        const namePrefix = prefix.slice(7).toLowerCase();
        return allTools
          .map((t) => ({ value: `delete ${t.name}`, label: t.name, description: t.description }))
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
      } else if (sub === "delete" || sub.startsWith("delete ")) {
        const toolName = trimmed.slice(6).trim() || undefined;
        await handleDelete(pi, ctx, deps, toolName);
      } else if (sub === "onboard") {
        await handleOnboard(pi, ctx, deps.projectRoot, deps.draftModelName);
      } else {
        ctx.ui.notify(`Unknown: ${sub}. Available: edit, delete, onboard`, "error");
      }
    },
  });
}

/** Combined view of persisted tools (deps.tools) and in-memory session tools. */
function allEditableTools(deps: ArmoryCommandDeps): ArmoryTool[] {
  const combined = new Map<string, ArmoryTool>();
  for (const t of deps.tools) combined.set(t.name, t);
  // Session tools override persisted (resolution order: session > project > global)
  for (const [name, t] of sessionRegistry) combined.set(name, t);
  return [...combined.values()].sort((a, b) => a.name.localeCompare(b.name));
}

type EditableToolEntry = { tool: ArmoryTool; source: ToolSource };

async function allEditableToolEntries(projectRoot: string): Promise<EditableToolEntry[]> {
  const combined = new Map<string, EditableToolEntry>();
  for (const entry of await loadToolsWithSource(projectRoot)) {
    combined.set(entry.tool.name, entry);
  }
  // Session tools override persisted tools in the active session.
  for (const [name, tool] of sessionRegistry) {
    combined.set(name, { tool, source: "session" });
  }
  return [...combined.values()].sort((a, b) => a.tool.name.localeCompare(b.tool.name));
}

/** Resolve a tool by name, checking session → project → global. */
async function resolveToolWithSource(
  name: string,
  projectRoot: string,
): Promise<{ tool: ArmoryTool; source: ToolSource } | null> {
  const sessionTool = sessionRegistry.get(name);
  if (sessionTool) return { tool: sessionTool, source: "session" };
  return loadToolWithSource(name, projectRoot);
}

async function restorePersistedToolIfAny(
  pi: ExtensionAPI,
  name: string,
  projectRoot: string,
  cwd: string,
): Promise<boolean> {
  const found = await loadToolWithSource(name, projectRoot);
  if (!found) return false;
  registerArmoryTool(pi, found.tool, await getDestinationEnvSets(found.source, projectRoot));
  syncToolCondition(pi, cwd, found.tool);
  return true;
}

async function deactivateToolUnlessPersisted(
  pi: ExtensionAPI,
  name: string,
  projectRoot: string,
  cwd: string,
): Promise<void> {
  // Fail closed before any fallible restore lookup: a stale handler must not remain active
  // after its approval gate is removed.
  const active = pi.getActiveTools().filter((activeName) => activeName !== name);
  pi.setActiveTools(active);
  toolRegistry.delete(name);
  approvalRegistry.delete(name);
  await restorePersistedToolIfAny(pi, name, projectRoot, cwd);
}

/** Human-readable confirmation copy for scope changes. */
function scopeChangeMessage(name: string, from: ToolSource, to: ToolSource): string {
  if (from === "session" && to === "project") {
    return (
      `Save '${name}' to project config (.pi/armory.json)?\n` +
      `It will be removed from the in-memory session registry and will persist after this session.`
    );
  }
  if (from === "session" && to === "global") {
    return (
      `Save '${name}' to global config (~/.pi/agent/armory.json)?\n` +
      `It will be removed from the in-memory session registry and will be available in all projects.`
    );
  }
  if (from === "project" && to === "session") {
    return (
      `Demote '${name}' to session-only?\n` +
      `It will be REMOVED from project config (.pi/armory.json) and lost when this session ends.`
    );
  }
  if (from === "global" && to === "session") {
    return (
      `Demote '${name}' to session-only?\n` +
      `It will be REMOVED from global config (~/.pi/agent/armory.json) and lost when this session ends.`
    );
  }
  if (from === "project" && to === "global") {
    return (
      `Move '${name}' from project config to global config (~/.pi/agent/armory.json)?\n` +
      `It will be available in all projects (not just this one).`
    );
  }
  if (from === "global" && to === "project") {
    return (
      `Move '${name}' from global config to project config (.pi/armory.json)?\n` +
      `It will be removed from global config, so other projects will no longer have it — it will only be available in this project.`
    );
  }
  return `Change destination for '${name}' from ${from} to ${to}?`;
}

async function pickEditableTool(
  ctx: ExtensionCommandContext,
  title: string,
  entries: EditableToolEntry[],
): Promise<string | null> {
  const selected = await ctx.ui.select(
    title,
    entries.map((entry) => entry.tool.name),
  );
  return selected ?? null;
}

async function handleEdit(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  deps: ArmoryCommandDeps,
  toolName?: string,
): Promise<void> {
  if (ctx.mode !== "tui") {
    ctx.ui.notify("/armory edit requires the interactive TUI.", "error");
    return;
  }

  // If no name, show a picker including session tools
  let selectedName = toolName;
  if (!selectedName) {
    const all = await allEditableToolEntries(deps.projectRoot);
    if (all.length === 0) {
      ctx.ui.notify("No tools registered", "error");
      return;
    }
    const picked = await pickEditableTool(ctx, "Select tool to edit", all);
    if (!picked) return;
    selectedName = picked;
  }

  // Resolve from session → project → global
  const found = await resolveToolWithSource(selectedName, deps.projectRoot);
  if (!found) {
    ctx.ui.notify(`Tool '${selectedName}' not found`, "error");
    return;
  }

  const { tool, source } = found;

  // Load each scope independently: an invalid unrelated config must not hide the valid scope.
  const envSets: Partial<Record<"project" | "global", Awaited<ReturnType<typeof getDestinationEnvSets>>>> = {};
  for (const scope of ["project", "global"] as const) {
    try {
      envSets[scope] = await getDestinationEnvSets(scope, deps.projectRoot);
    } catch {
      // The unavailable scope cannot be selected for persistence below.
    }
  }
  if (source !== "session" && !envSets[source]) {
    ctx.ui.notify("Could not load environment sets for this tool's config. Fix the config and retry.", "error");
    return;
  }

  const result = await showToolEditor(
    ctx,
    {
      title: "Edit Tool",
      name: tool.name,
      command: tool.command,
      description: tool.description,
      guidelines: tool.guidelines ?? [],
      requiresApproval: tool.requires_approval ?? false,
      destination: source,
      when: tool.when,
      envFrom: tool.envFrom,
      envSets,
    },
    deps.draftModelName,
  );

  if ("rejected" in result) return; // user rejected

  // Normalize and validate the edited name exactly like request_tool/onboarding, before any
  // persistence or registry mutation.
  const name = normalizeName(result.name);

  if (!name || !VALID_NAME.test(name)) {
    ctx.ui.notify(
      `Could not derive a valid tool name from '${result.name}'. Must contain at least one letter.`,
      "error",
    );
    return;
  }

  if (RESERVED_NAMES.has(name)) {
    ctx.ui.notify(`Cannot register tool with reserved name '${name}'.`, "error");
    return;
  }

  // Confirm if scope/destination is being changed
  if (result.destination !== source) {
    const msg = scopeChangeMessage(tool.name, source, result.destination);
    const choice = await ctx.ui.select(msg, ["Confirm", "Cancel"]);
    if (choice !== "Confirm") return; // user aborted — no changes applied
  }

  const selectedEnvFrom = result.envFrom ?? tool.envFrom ?? [];
  const destinationEnvSets = result.destination === "session" ? undefined : envSets[result.destination];
  if (
    (result.destination === "session" && selectedEnvFrom.length > 0) ||
    (result.destination !== "session" &&
      (!destinationEnvSets || selectedEnvFrom.some((setName) => !Object.hasOwn(destinationEnvSets, setName))))
  ) {
    ctx.ui.notify(
      "Environment set selection is unavailable for this destination. Review the config and retry.",
      "error",
    );
    return;
  }

  // A move must not write its destination if its source has become invalid since the form opened.
  if (source !== "session" && source !== result.destination) {
    try {
      await getDestinationEnvSets(source, deps.projectRoot);
    } catch {
      ctx.ui.notify("Could not load the source config. Fix the config and retry.", "error");
      return;
    }
  }

  const updatedTool = buildToolFromResult({ ...result, name }, { env: tool.env, envFrom: tool.envFrom });
  const sourceName = tool.name;
  const destName = updatedTool.name;
  let savedEnvSets = destinationEnvSets;

  // Apply changes based on source/destination combination
  if (source === "session" && result.destination === "session") {
    // Session → session: update in-memory registry only
    sessionRegistry.delete(sourceName);
    sessionRegistry.set(destName, updatedTool);
  } else if (source === "session" && result.destination !== "session") {
    // Session → project/global: persist and remove from session. If the session tool
    // shadowed a persisted tool and was renamed, leave the shadowed tool intact.
    try {
      const existing = await loadToolInDestination(destName, result.destination, deps.projectRoot);
      if (existing) {
        ctx.ui.notify(
          `Tool '${destName}' already exists in the destination config. Rename it or remove the existing tool and retry.`,
          "error",
        );
        return;
      }
      savedEnvSets = await saveConfig(
        updatedTool,
        result.destination,
        deps.projectRoot,
        undefined,
        destinationEnvSets,
        true,
      );
    } catch {
      ctx.ui.notify("Could not save tool: config or environment sets changed. Review the config and retry.", "error");
      return;
    }
    sessionRegistry.delete(sourceName);
    const replacedName = destName === sourceName ? sourceName : destName;
    const idx = deps.tools.findIndex((t) => t.name === replacedName);
    if (idx !== -1) deps.tools.splice(idx, 1);
    deps.tools.push(updatedTool);
  } else if (source !== "session" && result.destination === "session") {
    // Project/global → session: remove from config and keep in-memory only
    try {
      await removeFromConfig(sourceName, source, deps.projectRoot, undefined, tool);
    } catch {
      ctx.ui.notify("Could not remove tool from source config. Fix the config and retry.", "error");
      return;
    }
    sessionRegistry.set(destName, updatedTool);
    // Remove from persisted tool list
    const idx = deps.tools.findIndex((t) => t.name === sourceName);
    if (idx !== -1) deps.tools.splice(idx, 1);
  } else if (source !== "session" && result.destination !== "session") {
    // Project/global → project/global: persist (may move between locations)
    const needsRemoval = result.destination !== source || destName !== sourceName;
    try {
      if (needsRemoval) {
        const existing = await loadToolInDestination(destName, result.destination, deps.projectRoot);
        if (existing) {
          ctx.ui.notify(
            `Tool '${destName}' already exists in the destination config. Rename it or remove the existing tool and retry.`,
            "error",
          );
          return;
        }
      }
      savedEnvSets = needsRemoval
        ? await saveConfig(updatedTool, result.destination, deps.projectRoot, undefined, destinationEnvSets, true)
        : await saveConfig(updatedTool, result.destination, deps.projectRoot, undefined, destinationEnvSets);
    } catch {
      ctx.ui.notify("Could not save tool: config or environment sets changed. Review the config and retry.", "error");
      return;
    }
    if (needsRemoval) {
      try {
        await removeFromConfig(sourceName, source, deps.projectRoot, undefined, tool);
      } catch {
        try {
          await removeFromConfig(destName, result.destination, deps.projectRoot, undefined, updatedTool);
          ctx.ui.notify("Could not remove tool from source config. Review the config and retry.", "error");
        } catch {
          ctx.ui.notify(
            "Could not remove tool from source config; configs may be partially changed. Reconcile them manually before retrying.",
            "error",
          );
        }
        return;
      }
    }
    // Update persisted tool list
    const idx = deps.tools.findIndex((t) => t.name === sourceName);
    if (idx !== -1) deps.tools.splice(idx, 1);
    deps.tools.push(updatedTool);
  }

  if (destName === sourceName) approvalRegistry.delete(sourceName);
  if (result.destination === "session") {
    registerArmoryTool(pi, updatedTool);
  } else {
    registerArmoryTool(pi, updatedTool, savedEnvSets);
  }

  // Deactivate old tool name on rename unless a lower-precedence persisted tool is revealed.
  if (destName !== sourceName) {
    await deactivateToolUnlessPersisted(pi, sourceName, deps.projectRoot, ctx.cwd);
  }

  // Sync the (re)registered tool's active state with its condition for this workspace.
  syncToolCondition(pi, ctx.cwd, updatedTool);

  ctx.ui.notify(`Tool '${updatedTool.name}' updated`, "info");
}

async function handleDelete(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  deps: ArmoryCommandDeps,
  toolName?: string,
): Promise<void> {
  // If no name, show a picker including session tools
  let selectedName = toolName;
  if (!selectedName) {
    const all = await allEditableToolEntries(deps.projectRoot);
    if (all.length === 0) {
      ctx.ui.notify("No tools registered", "error");
      return;
    }
    const picked = await pickEditableTool(ctx, "Select tool to delete", all);
    if (!picked) return;
    selectedName = picked;
  }

  // Resolve from session → project → global
  const found = await resolveToolWithSource(selectedName, deps.projectRoot);
  if (!found) {
    ctx.ui.notify(`Tool '${selectedName}' not found`, "error");
    return;
  }

  const { tool, source } = found;

  // Build confirmation message
  let confirmMsg: string;
  if (source === "session") {
    confirmMsg =
      `Delete '${tool.name}' from the current session?\n` +
      `This tool is only in memory (not saved to config) — it will be gone immediately.`;
  } else if (source === "project") {
    confirmMsg = `Delete '${tool.name}' from project config (.pi/armory.json)?\nThis cannot be undone.`;
  } else {
    confirmMsg = `Delete '${tool.name}' from global config (~/.pi/agent/armory.json)?\nThis cannot be undone.`;
  }

  const choice = await ctx.ui.select(confirmMsg, ["Delete", "Cancel"]);
  if (choice !== "Delete") return;

  // Remove from source
  if (source === "session") {
    sessionRegistry.delete(tool.name);
  } else {
    try {
      await removeFromConfig(tool.name, source, deps.projectRoot, undefined, tool);
    } catch {
      ctx.ui.notify("Could not remove tool from source config. Review the config and retry.", "error");
      return;
    }
    const idx = deps.tools.findIndex((t) => t.name === tool.name);
    if (idx !== -1) deps.tools.splice(idx, 1);
  }

  // Deactivate before attempting to reveal a lower-precedence persisted tool.
  await deactivateToolUnlessPersisted(pi, tool.name, deps.projectRoot, ctx.cwd);

  ctx.ui.notify(`Tool '${tool.name}' deleted`, "info");
}
