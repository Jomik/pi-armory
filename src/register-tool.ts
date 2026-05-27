import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type TObject, Type } from "typebox";
import { Value } from "typebox/value";
import type { ArmoryTool } from "./config.js";
import { executeCommand } from "./executor.js";
import { fetchSecret } from "./keychain.js";

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function interpolateCommand(
  command: string,
  params: Record<string, unknown>,
  paramDefs?: Record<string, { type: string; optional?: boolean }>,
): string {
  const result = command.replace(
    /(["'])\{\{(\.\.\.)?([\w]+)(\?)?\}\}\1|\{\{(\.\.\.)?([\w]+)(\?)?\}\}/g,
    (_match, _quote, quotedSpread, quotedKey, quotedOpt, bareSpread, bareKey, bareOpt) => {
      const key = quotedKey ?? bareKey;
      const isVariadic = (quotedSpread ?? bareSpread) === "..." || paramDefs?.[key]?.type === "string[]";
      const isOptional = (quotedOpt ?? bareOpt) === "?" || paramDefs?.[key]?.optional === true;

      if (!(key in params) || params[key] === undefined) {
        if (isOptional) {
          return "";
        }
        throw new Error(`Missing required parameter: ${key}`);
      }

      const value = params[key];

      if (isVariadic && Array.isArray(value)) {
        if (value.length === 0) return "";
        return (value as unknown[]).map((v) => shellEscape(String(v))).join(" ");
      }

      return shellEscape(String(value));
    },
  );

  // Trim edges (from omitted optional params at start/end of command)
  return result.trim();
}

function buildParamSchema(parameters: NonNullable<ArmoryTool["parameters"]>): TObject {
  return Type.Object(
    Object.fromEntries(
      Object.entries(parameters).map(([key, def]) => {
        const desc = def.description ?? key;
        let fieldSchema =
          def.type === "string[]"
            ? Type.Array(Type.String(), { description: desc, minItems: 1 })
            : Type.String({ description: desc, minLength: 1 });
        if (def.optional) {
          fieldSchema = Type.Optional(fieldSchema);
        }
        return [key, fieldSchema];
      }),
    ),
  );
}

/** Tools with requires_approval, keyed by name. Updated by registerArmoryTool. */
export const approvalRegistry = new Map<string, ArmoryTool>();

export function registerArmoryTool(pi: ExtensionAPI, tool: ArmoryTool) {
  if (tool.requires_approval) {
    approvalRegistry.set(tool.name, tool);
  }
  const schema = tool.parameters ? buildParamSchema(tool.parameters) : Type.Object({});

  pi.registerTool({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    promptSnippet: `Runs the command \`${tool.command}\``,
    promptGuidelines: tool.guidelines,
    parameters: schema,
    renderCall(args, theme, _context) {
      let text = theme.fg("toolTitle", theme.bold(`${tool.name} `));
      let cmd: string;
      try {
        cmd = tool.parameters
          ? interpolateCommand(tool.command, args as Record<string, unknown>, tool.parameters)
          : tool.command;
      } catch {
        // Args still streaming — show template
        cmd = tool.command;
      }
      text += theme.fg("accent", cmd);
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded, isPartial }, theme, context) {
      if (isPartial) {
        return new Text(theme.fg("warning", "Running..."), 0, 0);
      }

      const content = result.content[0];
      const output = content?.type === "text" ? content.text : "";
      const lines = output.split("\n");

      let text: string;
      if (context.isError) {
        text = theme.fg("error", "failed");
      } else {
        text = theme.fg("success", "done");
      }
      text += theme.fg("dim", ` (${lines.length} lines)`);

      if (!expanded) {
        text += theme.fg("muted", ` ${keyHint("app.tools.expand", "to expand")}`);
      } else {
        const preview = lines.slice(0, 30);
        for (const line of preview) {
          text += `\n${theme.fg("dim", line)}`;
        }
        if (lines.length > 30) {
          text += `\n${theme.fg("muted", `... ${lines.length - 30} more lines`)}`;
        }
      }

      return new Text(text, 0, 0);
    },

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      // Validate parameters against schema
      if (tool.parameters) {
        if (!Value.Check(schema, params)) {
          const errors = Value.Errors(schema, params);
          const msg = errors.map((e) => `${e.instancePath || "/"}: ${e.message}`).join("; ");
          throw new Error(`Invalid parameters: ${msg}`);
        }
      }

      // Interpolate parameters into the command string
      const command = tool.parameters
        ? interpolateCommand(tool.command, params as Record<string, unknown>, tool.parameters)
        : tool.command;

      // Fetch secrets from keychain and prepare extraEnv / redact
      let extraEnv: Record<string, string> | undefined;
      let redact: string[] | undefined;
      if (tool.secrets && Object.keys(tool.secrets).length > 0) {
        const entries = Object.entries(tool.secrets);
        const values = await Promise.all(entries.map(([, account]) => fetchSecret(account)));
        extraEnv = Object.fromEntries(entries.map(([envVar], i) => [envVar, values[i] as string]));
        redact = values;
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
        extraEnv,
        redact,
      });

      return {
        content: [{ type: "text", text: output || "(no output)" }],
        details: undefined,
      };
    },
  });
}
