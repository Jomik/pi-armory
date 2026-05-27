import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";
import { registerArmoryCommand } from "./manage-secrets.js";
import { approvalRegistry, interpolateCommand, registerArmoryTool } from "./register-tool.js";
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

    const command = tool.parameters
      ? interpolateCommand(tool.command, event.input as Record<string, unknown>, tool.parameters)
      : tool.command;

    const approved = await ctx.ui.confirm(`Run: ${tool.name}`, `Command: ${command}\n\nApprove execution?`);
    if (!approved) {
      return { block: true, reason: `Execution of '${tool.name}' rejected by user.` };
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
