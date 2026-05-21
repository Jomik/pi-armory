import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ArmoryTool } from "./config.js";
import { executeCommand } from "./executor.js";

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function interpolateCommand(command: string, params: Record<string, unknown>): string {
  return command.replace(/(["'])\{\{(\w+)\}\}\1|\{\{(\w+)\}\}/g, (_match, _quote, quotedKey, bareKey) => {
    const key = quotedKey ?? bareKey;
    if (!(key in params)) {
      throw new Error(`Missing required parameter: ${key}`);
    }
    return shellEscape(String(params[key]));
  });
}

export function registerArmoryTool(pi: ExtensionAPI, tool: ArmoryTool) {
  const schema = tool.parameters
    ? Type.Object(
        Object.fromEntries(
          Object.entries(tool.parameters).map(([key, def]) => [
            key,
            Type.String({ description: def.description ?? key }),
          ]),
        ),
      )
    : Type.Object({});

  pi.registerTool({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    promptSnippet: `Runs the command \`${tool.command}\``,
    promptGuidelines: tool.guidelines,
    parameters: schema,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      // Interpolate parameters into the command string
      const command = tool.parameters
        ? interpolateCommand(tool.command, params as Record<string, unknown>)
        : tool.command;

      // If requires_approval, confirm with user first
      if (tool.requires_approval) {
        const approved = await ctx.ui.confirm(`Run: ${tool.name}`, `Command: ${command}\n\nApprove execution?`);
        if (!approved) {
          return {
            content: [{ type: "text", text: `Execution of '${tool.name}' rejected by user. Command was: ${command}` }],
            details: undefined,
          };
        }
      }

      // Execute the command, streaming output
      const output = await executeCommand(command, {
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
