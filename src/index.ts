import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { type ApprovalAction, createApprovalPanel } from "./approval-panel.js";
import { registerArmoryCommand } from "./commands.js";
import { loadConfig, loadProjectToolNamesSync } from "./config.js";
import { parsePlaceholders } from "./placeholders.js";
import {
  approvalRegistry,
  buildParamSchema,
  interpolateCommand,
  registerArmoryTool,
  toolRegistry,
  validateToolParams,
} from "./register-tool.js";
import { detectRepositoryType, toolConditionMatches } from "./repository.js";
import { registerRequestTool } from "./request-tool.js";

const factory: ExtensionFactory = async (pi) => {
  const projectRoot = process.cwd();
  const { tools, envSetsByTool, draftModel, disableBash } = await loadConfig(projectRoot);

  pi.on("session_start", async (_event, ctx) => {
    let active = pi.getActiveTools();

    if (disableBash) {
      active = active.filter((name) => name !== "bash");
    }

    const repoType = detectRepositoryType(ctx.cwd);
    const conditionalTools = [...toolRegistry.values()].filter((tool) => tool.when);
    const conditionalNames = new Set(conditionalTools.map((tool) => tool.name));

    // Remove conditional tools whose condition no longer matches, preserving the order and
    // state of all unrelated/unconditional names.
    active = active.filter((name) => {
      if (!conditionalNames.has(name)) return true;
      const tool = conditionalTools.find((t) => t.name === name);
      return tool ? toolConditionMatches(tool.when, repoType) : true;
    });

    // Re-add conditional tools whose condition matches but that are not currently active.
    for (const tool of conditionalTools) {
      if (toolConditionMatches(tool.when, repoType) && !active.includes(tool.name)) {
        active.push(tool.name);
      }
    }

    pi.setActiveTools(active);
  });

  for (const tool of tools) {
    registerArmoryTool(pi, tool, envSetsByTool?.[tool.name]);
  }

  // Approval gate via tool_call event — preflighted sequentially by pi,
  // so concurrent tool calls with requires_approval serialize naturally.
  // Uses approvalRegistry which is updated by registerArmoryTool (including runtime registrations).
  // Also blocks parallel request_tool calls (only one form at a time).
  let requestToolInFlight = false;
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "request_tool") {
      if (requestToolInFlight) {
        return { block: true, reason: "request_tool is already in progress. Call it one at a time." };
      }
      requestToolInFlight = true;
      return;
    }

    const tool = approvalRegistry.get(event.toolName);
    if (!tool) return;

    let input = event.input as Record<string, unknown>;

    const schema = buildParamSchema(tool);
    const validatedInitial = validateToolParams(schema, input);
    if (!validatedInitial.ok) {
      return { block: true, reason: `Cannot run '${tool.name}': Invalid parameters: ${validatedInitial.message}` };
    }
    input = validatedInitial.value;

    try {
      interpolateCommand(tool.command, input);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "interpolation failed";
      return { block: true, reason: `Cannot run '${tool.name}': ${msg}` };
    }

    if (ctx.mode !== "tui") {
      return {
        block: true,
        reason: `Cannot run '${tool.name}': approval required but the session is not in interactive TUI mode.`,
      };
    }
    if (!ctx.hasUI) {
      return { block: true, reason: `Cannot run '${tool.name}': approval required but no UI is available.` };
    }

    const allowEdit = parsePlaceholders(tool.command).length > 0;

    for (;;) {
      const result = await ctx.ui.custom<ApprovalAction>((tui, theme, _kb, done) =>
        createApprovalPanel(tui, theme, done, {
          toolName: tool.name,
          command: tool.command,
          params: input,
          allowEdit,
        }),
      );
      const action: ApprovalAction = result === "run" || result === "edit" ? result : "reject";

      if (action === "run") {
        (event as { input: Record<string, unknown> }).input = input;
        return;
      }
      if (action === "reject") {
        return { block: true, reason: `Execution of '${tool.name}' rejected by user.` };
      }

      // action === "edit": loop on the editor until valid input, cancel, or dismissal.
      for (;;) {
        const edited = await ctx.ui.editor(`Edit parameters: ${tool.name}`, JSON.stringify(input, null, 2));
        if (edited === undefined) break; // cancel -> back to review, unchanged

        let parsed: unknown;
        try {
          parsed = JSON.parse(edited);
        } catch {
          ctx.ui.notify("Invalid JSON. Fix and retry, or cancel to keep current values.", "error");
          continue;
        }

        const validated = validateToolParams(schema, parsed);
        if (!validated.ok) {
          ctx.ui.notify(`Invalid parameters: ${validated.message}`, "error");
          continue;
        }

        input = validated.value;
        (event as { input: Record<string, unknown> }).input = input;
        break; // valid edit -> back to review
      }
    }
  });

  pi.on("tool_execution_end", async (event) => {
    if (event.toolName === "request_tool") {
      requestToolInFlight = false;
    }
  });

  pi.events.on("pi-armory:project-tools:v1", (payload) => {
    if (
      typeof payload !== "object" ||
      payload === null ||
      typeof (payload as { respond?: unknown }).respond !== "function"
    ) {
      return;
    }
    const { respond } = payload as { respond: (toolNames: string[]) => void };
    respond(loadProjectToolNamesSync(projectRoot));
  });

  registerRequestTool(pi, projectRoot, draftModel);
  registerArmoryCommand(pi, { tools, projectRoot, draftModelName: draftModel });
};

export default factory;
