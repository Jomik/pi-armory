import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ArmoryTool } from "./config.js";
import { executeCommand } from "./executor.js";

export function registerArmoryTool(pi: ExtensionAPI, tool: ArmoryTool) {
  pi.registerTool({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    promptSnippet: `Runs the command \`${tool.command}\``,
    promptGuidelines: tool.guidelines,
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal, onUpdate, ctx) {
      // If requires_approval, confirm with user first
      if (tool.requires_approval) {
        const approved = await ctx.ui.confirm(`Run: ${tool.name}`, `Command: ${tool.command}\n\nApprove execution?`);
        if (!approved) {
          return {
            content: [
              { type: "text", text: `Execution of '${tool.name}' rejected by user. Command was: ${tool.command}` },
            ],
            details: undefined,
          };
        }
      }

      // Execute the command, streaming output
      const output = await executeCommand(tool.command, {
        cwd: ctx.cwd,
        signal: signal,
        onUpdate: onUpdate
          ? (text) =>
              onUpdate({
                content: [{ type: "text", text }],
                details: undefined,
              })
          : undefined,
      });

      return {
        content: [{ type: "text", text: output || "(no output)" }],
        details: undefined,
      };
    },
  });
}
