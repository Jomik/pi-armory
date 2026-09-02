import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { type ApprovalAction, createApprovalPanel } from "./approval-panel.js";
import { registerArmoryCommand } from "./commands.js";
import { loadConfig } from "./config.js";
import { parsePlaceholders } from "./placeholders.js";
import {
  approvalRegistry,
  buildParamSchema,
  interpolateCommand,
  registerArmoryTool,
  validateToolParams,
} from "./register-tool.js";
import { registerRequestTool } from "./request-tool.js";

const factory: ExtensionFactory = async (pi) => {
  const projectRoot = process.cwd();
  const { tools, draftModel, disableBash } = await loadConfig(projectRoot);

  if (disableBash) {
    pi.on("session_start", async (_event, _ctx) => {
      const active = pi.getActiveTools().filter((name) => name !== "bash");
      pi.setActiveTools(active);
    });
  }

  for (const tool of tools) {
    registerArmoryTool(pi, tool);
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

    pi.events.emit("herdr:blocked", { active: true, label: `approve tool: ${tool.name}` });
    try {
      if (!ctx.hasUI) {
        return { block: true, reason: `Cannot run '${tool.name}': approval required but no UI is available.` };
      }

      const allowEdit = parsePlaceholders(tool.command).length > 0;

      for (;;) {
        const command = interpolateCommand(tool.command, input);
        const action = await ctx.ui.custom<ApprovalAction>((tui, theme, _kb, done) =>
          createApprovalPanel(tui, theme, done, {
            toolName: tool.name,
            command,
            params: input,
            allowEdit,
          }),
        );

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
    } finally {
      pi.events.emit("herdr:blocked", { active: false });
    }
  });

  pi.on("tool_execution_end", async (event) => {
    if (event.toolName === "request_tool") {
      requestToolInFlight = false;
    }
  });

  registerRequestTool(pi, projectRoot, draftModel);
  registerArmoryCommand(pi, { tools, projectRoot, draftModelName: draftModel });
};

export default factory;
