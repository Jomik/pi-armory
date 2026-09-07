import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Key,
  matchesKey,
  type SelectItem,
  SelectList,
  Text,
  type TUI,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import type { ArmoryTool, ToolSource } from "./config.js";
import { loadToolsWithSource, loadToolWithSource, removeFromConfig, saveConfig } from "./config.js";
import { handleOnboard } from "./onboard.js";
import { approvalRegistry, registerArmoryTool, sessionRegistry } from "./register-tool.js";
import { SecretsPanel } from "./secrets-panel.js";
import { buildToolFromResult, showToolEditor } from "./shared.js";

export interface ArmoryCommandDeps {
  tools: ArmoryTool[];
  projectRoot: string;
  draftModelName?: string;
}

export function registerArmoryCommand(pi: ExtensionAPI, deps: ArmoryCommandDeps): void {
  pi.registerCommand("armory", {
    description: "Manage armory: /armory secrets | /armory edit [name] | /armory delete [name] | /armory onboard",
    getArgumentCompletions(prefix) {
      const items = [
        { value: "secrets", label: "secrets", description: "Manage keychain secrets" },
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
      } else if (sub === "secrets") {
        await handleSecrets(ctx, deps.tools);
      } else if (sub === "onboard") {
        await handleOnboard(pi, ctx, deps.projectRoot, deps.draftModelName);
      } else {
        ctx.ui.notify(`Unknown: ${sub}. Available: secrets, edit, delete, onboard`, "error");
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

/** Combined view of persisted tools (deps.tools) and in-memory session tools. */
function allEditableTools(deps: ArmoryCommandDeps): ArmoryTool[] {
  const combined = new Map<string, ArmoryTool>();
  for (const t of deps.tools) combined.set(t.name, t);
  // Session tools override persisted (resolution order: session > project > global)
  for (const [name, t] of sessionRegistry) combined.set(name, t);
  return [...combined.values()].sort((a, b) => a.name.localeCompare(b.name));
}

type EditableToolEntry = { tool: ArmoryTool; source: ToolSource };
type ToolPickerScope = ToolSource | "all";

const TOOL_PICKER_SCOPES: ToolPickerScope[] = ["all", "session", "project", "global"];

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

async function restorePersistedToolIfAny(pi: ExtensionAPI, name: string, projectRoot: string): Promise<boolean> {
  const found = await loadToolWithSource(name, projectRoot);
  if (!found) return false;
  registerArmoryTool(pi, found.tool);
  return true;
}

async function deactivateToolUnlessPersisted(pi: ExtensionAPI, name: string, projectRoot: string): Promise<void> {
  const restored = await restorePersistedToolIfAny(pi, name, projectRoot);
  if (restored) return;
  const active = pi.getActiveTools().filter((activeName) => activeName !== name);
  pi.setActiveTools(active);
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
      `It will only be available in this project and will override the global version.`
    );
  }
  return `Change destination for '${name}' from ${from} to ${to}?`;
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
  );
}

function scopeLabel(scope: ToolPickerScope): string {
  return scope.charAt(0).toUpperCase() + scope.slice(1);
}

function sourceDescription(entry: EditableToolEntry): string {
  const parts = [`[${entry.source}]`, entry.tool.description];
  if (entry.tool.command) parts.push(`— ${entry.tool.command}`);
  return parts.join(" ");
}

function pickerItems(entries: EditableToolEntry[], scope: ToolPickerScope): SelectItem[] {
  return entries
    .filter((entry) => scope === "all" || entry.source === scope)
    .map((entry) => ({
      value: entry.tool.name,
      label: entry.tool.name,
      description: sourceDescription(entry),
    }));
}

function createToolPicker(
  tui: TUI,
  theme: Theme,
  title: string,
  entries: EditableToolEntry[],
  done: (toolName: string | null) => void,
) {
  let scopeIndex = 0;
  let filter = "";
  let selectList = buildSelectList();

  const container = new Container();

  function currentScope(): ToolPickerScope {
    return TOOL_PICKER_SCOPES[scopeIndex] ?? "all";
  }

  function buildSelectList(): SelectList {
    const items = pickerItems(entries, currentScope());
    const list = new SelectList(items, Math.min(items.length, 14), {
      selectedPrefix: (text: string) => theme.fg("accent", text),
      selectedText: (text: string) => theme.fg("accent", text),
      description: (text: string) => theme.fg("muted", text),
      scrollInfo: (text: string) => theme.fg("dim", text),
      noMatch: (text: string) => theme.fg("warning", text),
    });
    list.setFilter(filter);
    list.onSelect = (item) => done(item.value);
    list.onCancel = () => done(null);
    return list;
  }

  function rebuildList(): void {
    selectList = buildSelectList();
    container.invalidate();
  }

  function renderScopes(width: number): string {
    const scopeText = TOOL_PICKER_SCOPES.map((scope, i) => {
      const text = scopeLabel(scope);
      return i === scopeIndex ? theme.fg("accent", theme.bold(text)) : theme.fg("muted", text);
    }).join(theme.fg("dim", " | "));
    return truncateToWidth(` ${scopeText}`, width);
  }

  return {
    invalidate() {
      container.invalidate();
      selectList.invalidate();
    },

    render(width: number): string[] {
      container.clear();
      const maxW = Math.min(width, 110);
      const hr = theme.fg("accent", "─".repeat(maxW));
      container.addChild(new Text(hr, 0, 0));
      container.addChild(new Text(` ${theme.fg("accent", theme.bold(title))}`, 0, 0));
      container.addChild(new Text(renderScopes(maxW), 0, 0));
      container.addChild(
        new Text(` ${theme.fg("dim", filter ? `Filter: ${filter}` : "Type to filter by name")}`, 0, 0),
      );
      container.addChild(selectList);
      container.addChild(
        new Text(
          theme.fg("dim", " ↑↓ navigate • tab scope • type filter • backspace clear • enter select • esc cancel"),
          0,
          0,
        ),
      );
      container.addChild(new Text(hr, 0, 0));
      return container.render(width).map((line) => truncateToWidth(line, width));
    },

    handleInput(data: string) {
      if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
        scopeIndex = (scopeIndex + 1) % TOOL_PICKER_SCOPES.length;
        rebuildList();
        tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
        scopeIndex = (scopeIndex + TOOL_PICKER_SCOPES.length - 1) % TOOL_PICKER_SCOPES.length;
        rebuildList();
        tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.backspace) && filter.length > 0) {
        filter = filter.slice(0, -1);
        rebuildList();
        tui.requestRender();
        return;
      }
      if (matchesKey(data, Key.escape) && filter.length > 0) {
        filter = "";
        rebuildList();
        tui.requestRender();
        return;
      }
      if (data.length === 1 && data.charCodeAt(0) >= 32 && data.charCodeAt(0) !== 127) {
        filter += data;
        rebuildList();
        tui.requestRender();
        return;
      }
      selectList.handleInput(data);
      tui.requestRender();
    },
  };
}

async function pickEditableTool(
  ctx: ExtensionCommandContext,
  title: string,
  entries: EditableToolEntry[],
): Promise<string | null> {
  const picked = await ctx.ui.custom<string | null | undefined>((tui, theme, _keybindings, done) =>
    createToolPicker(tui, theme, title, entries, done),
  );
  if (picked !== undefined) return picked;

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
    },
    deps.draftModelName,
  );

  if ("rejected" in result) return; // user rejected

  // Confirm if scope/destination is being changed
  if (result.destination !== source) {
    const msg = scopeChangeMessage(tool.name, source, result.destination);
    const choice = await ctx.ui.select(msg, ["Confirm", "Cancel"]);
    if (choice !== "Confirm") return; // user aborted — no changes applied
  }

  const updatedTool = buildToolFromResult(result, { env: tool.env, secrets: tool.secrets });
  const sourceName = tool.name;
  const destName = updatedTool.name;

  // Apply changes based on source/destination combination
  if (source === "session" && result.destination === "session") {
    // Session → session: update in-memory registry only
    sessionRegistry.delete(sourceName);
    sessionRegistry.set(destName, updatedTool);
  } else if (source === "session" && result.destination !== "session") {
    // Session → project/global: persist and remove from session. If the session tool
    // shadowed a persisted tool and was renamed, leave the shadowed tool intact.
    await saveConfig(updatedTool, result.destination as "project" | "global", deps.projectRoot);
    sessionRegistry.delete(sourceName);
    const replacedName = destName === sourceName ? sourceName : destName;
    const idx = deps.tools.findIndex((t) => t.name === replacedName);
    if (idx !== -1) deps.tools.splice(idx, 1);
    deps.tools.push(updatedTool);
  } else if (source !== "session" && result.destination === "session") {
    // Project/global → session: remove from config and keep in-memory only
    await removeFromConfig(sourceName, source as "project" | "global", deps.projectRoot);
    sessionRegistry.set(destName, updatedTool);
    // Remove from persisted tool list
    const idx = deps.tools.findIndex((t) => t.name === sourceName);
    if (idx !== -1) deps.tools.splice(idx, 1);
  } else {
    // Project/global → project/global: persist (may move between locations)
    await saveConfig(updatedTool, result.destination as "project" | "global", deps.projectRoot);
    if (result.destination !== source || destName !== sourceName) {
      await removeFromConfig(sourceName, source as "project" | "global", deps.projectRoot);
    }
    // Update persisted tool list
    const idx = deps.tools.findIndex((t) => t.name === sourceName);
    if (idx !== -1) deps.tools.splice(idx, 1);
    deps.tools.push(updatedTool);
  }

  approvalRegistry.delete(sourceName);
  registerArmoryTool(pi, updatedTool);

  // Deactivate old tool name on rename unless a lower-precedence persisted tool is revealed.
  if (destName !== sourceName) {
    await deactivateToolUnlessPersisted(pi, sourceName, deps.projectRoot);
  }

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
    await removeFromConfig(tool.name, source as "project" | "global", deps.projectRoot);
    const idx = deps.tools.findIndex((t) => t.name === tool.name);
    if (idx !== -1) deps.tools.splice(idx, 1);
  }

  // Clean up approval registry and deactivate unless a lower-precedence persisted tool is revealed.
  approvalRegistry.delete(tool.name);
  await deactivateToolUnlessPersisted(pi, tool.name, deps.projectRoot);

  ctx.ui.notify(`Tool '${tool.name}' deleted`, "info");
}
