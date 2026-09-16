import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { keyHint } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type TObject, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import type { ArmoryTool, EnvBinding } from "./config.js";
import { executeCommand } from "./executor.js";
import { FLAG_PLACEHOLDER_RE, formatParamValue, parsePlaceholders } from "./shared.js";

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function collapseUnquotedSpaces(s: string): string {
  let out = "";
  let inQuote = false;
  let i = 0;
  while (i < s.length) {
    if (s[i] === "'" && !inQuote) {
      inQuote = true;
      out += s[i];
      i++;
    } else if (s[i] === "'" && inQuote) {
      // Check for escaped quote pattern: '\''
      if (s.slice(i, i + 4) === "'\\''") {
        out += "'\\''";
        i += 4;
      } else {
        inQuote = false;
        out += s[i];
        i++;
      }
    } else if (!inQuote && s[i] === " ") {
      // Collapse consecutive unquoted spaces to single space (preserve newlines/tabs)
      out += " ";
      while (i < s.length && s[i] === " ") i++;
    } else {
      out += s[i];
      i++;
    }
  }
  return out.replace(/^ +| +$/g, "");
}

export function interpolateCommand(command: string, params: Record<string, unknown>): string {
  // Phase 1: Replace flag placeholders ({{--flag}}, {{--flag?}}, {{--flag value}}, {{--flag value?}}, etc.)
  let result = command.replace(
    FLAG_PLACEHOLDER_RE(),
    (_match, flagStr: string, valName: string | undefined, valOpt: string | undefined, boolOpt: string | undefined) => {
      if (valName !== undefined) {
        // Flag+value placeholder
        const isOptional = valOpt === "?";
        if (!Object.hasOwn(params, valName) || params[valName] === undefined) {
          if (isOptional) return "";
          throw new Error(`Missing required parameter: ${valName}`);
        }
        return `${flagStr} ${shellEscape(String(params[valName]))}`;
      }
      // Boolean flag placeholder
      const name = flagStr.replace(/^-+/, "");
      const isOptional = boolOpt === "?";
      if (!Object.hasOwn(params, name) || params[name] === undefined) {
        if (isOptional) return "";
        throw new Error(`Missing required parameter: ${name}`);
      }
      return params[name] === true ? flagStr : "";
    },
  );

  // Phase 2: Replace regular placeholders ({{name}}, {{name?}}, {{...name}}, {{...name?}})
  result = result.replace(
    /(["'])\{\{(\.\.\.)?([\w]+)(\?)?\}\}\1|\{\{(\.\.\.)?([\w]+)(\?)?\}\}/g,
    (_match, _quote, quotedSpread, quotedKey, quotedOpt, bareSpread, bareKey, bareOpt) => {
      const key = quotedKey ?? bareKey;
      const isVariadic = (quotedSpread ?? bareSpread) === "...";
      const isOptional = (quotedOpt ?? bareOpt) === "?";

      if (!Object.hasOwn(params, key) || params[key] === undefined) {
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

  // Collapse consecutive spaces (from omitted flags) and trim edges, but preserve whitespace inside single-quoted values
  return collapseUnquotedSpaces(result);
}

export function buildParamSchema(tool: ArmoryTool): TObject {
  const parsed = parsePlaceholders(tool.command);
  if (parsed.length === 0) return Type.Object({});

  return Type.Object(
    Object.fromEntries(
      parsed.map((p) => {
        let fieldSchema: TSchema;
        switch (p.kind) {
          case "boolean-flag":
            fieldSchema = Type.Boolean({ description: p.name });
            break;
          case "regular":
            fieldSchema = p.variadic
              ? Type.Array(Type.String(), { description: p.name, minItems: 1 })
              : Type.String({ description: p.name, minLength: 1 });
            break;
          case "value-flag":
            fieldSchema = Type.String({ description: p.name, minLength: 1 });
            break;
        }
        if (p.optional) {
          fieldSchema = Type.Optional(fieldSchema);
        }
        return [p.name, fieldSchema];
      }),
    ),
  );
}

/**
 * Resolves a single binding value into its concrete string value, plus whether it
 * should be redacted from tool output.
 *
 * - A plain string is a public literal, used verbatim.
 * - `{ env }` reads a host environment variable.
 * - `{ command }` runs a shell command (via the tool's cwd/signal, no streaming) and
 *   uses its trimmed stdout only — stderr is captured for failure context but never
 *   contaminates the resolved value.
 *
 * Resolver commands are independent: they never see previously resolved bindings.
 */
async function resolveBinding(
  envVar: string,
  binding: EnvBinding,
  ctx: { cwd: string; signal?: AbortSignal },
): Promise<{ value: string; secret: boolean }> {
  if (typeof binding === "string") {
    return { value: binding, secret: false };
  }

  if ("env" in binding) {
    const resolved = process.env[binding.env];
    if (resolved == null) {
      throw new Error(
        `Environment variable '${binding.env}' (referenced by env.${envVar}) is not set. ` +
          `Set it in your shell before launching pi, or use a literal value in armory.json.`,
      );
    }
    return { value: resolved, secret: binding.secret === true };
  }

  // { command }
  let output: string;
  try {
    output = await executeCommand(binding.command, { cwd: ctx.cwd, signal: ctx.signal, stdoutOnly: true });
  } catch (err) {
    if (binding.secret) {
      throw new Error(`Failed to resolve secret environment binding 'env.${envVar}'.`);
    }
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to resolve environment binding 'env.${envVar}': ${msg}`);
  }
  const trimmed = output.trim();
  if (!trimmed) {
    throw new Error(`Resolver command for env.${envVar} produced no output.`);
  }
  return { value: trimmed, secret: binding.secret === true };
}

/**
 * Resolves all env bindings for a tool into extraEnv and redact arrays.
 */
async function resolveToolEnvironment(
  tool: ArmoryTool,
  ctx: { cwd: string; signal?: AbortSignal },
): Promise<{ extraEnv?: Record<string, string>; redact?: string[] }> {
  if (!tool.env || Object.keys(tool.env).length === 0) {
    return {};
  }

  const extraEnv: Record<string, string> = {};
  const redact: string[] = [];

  for (const [envVar, binding] of Object.entries(tool.env)) {
    const { value, secret } = await resolveBinding(envVar, binding, ctx);
    extraEnv[envVar] = value;
    if (secret) redact.push(value);
  }

  return {
    extraEnv: Object.keys(extraEnv).length > 0 ? extraEnv : undefined,
    redact: redact.length > 0 ? redact : undefined,
  };
}

/**
 * Validates params against a schema, returning either the validated value or a
 * human-readable error message. Shared by tool execution and approval-menu edits
 * so both paths enforce identical rules and produce identical error text.
 */
export function validateToolParams(
  schema: TSchema,
  params: unknown,
): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  if (!Value.Check(schema, params)) {
    const errors = Value.Errors(schema, params);
    const message = errors.map((e) => `${e.instancePath || "/"}: ${e.message}`).join("; ");
    return { ok: false, message };
  }
  return { ok: true, value: params as Record<string, unknown> };
}

/** Tools with requires_approval, keyed by name. Updated by registerArmoryTool. */
export const approvalRegistry = new Map<string, ArmoryTool>();

/** In-memory registry of session-only tools (not persisted to config). */
export const sessionRegistry = new Map<string, ArmoryTool>();

/**
 * Latest effective ArmoryTool definition for every registered tool name, updated by
 * registerArmoryTool. Used to reconcile conditional tools against the current state
 * (including runtime-created/edited/session tools) rather than a stale initial snapshot.
 */
export const toolRegistry = new Map<string, ArmoryTool>();

export function registerArmoryTool(pi: ExtensionAPI, tool: ArmoryTool) {
  toolRegistry.set(tool.name, tool);
  if (tool.requires_approval) {
    approvalRegistry.set(tool.name, tool);
  } else {
    approvalRegistry.delete(tool.name);
  }
  const schema = buildParamSchema(tool);

  pi.registerTool({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    promptSnippet: `Runs the command \`${tool.command}\``,
    promptGuidelines: tool.requires_approval
      ? [
          "This tool prompts the user for approval when called. Call it directly; do not ask for approval first.",
        ].concat(tool.guidelines ?? [])
      : tool.guidelines,
    parameters: schema,
    renderCall(args, theme, context) {
      const title = theme.fg("toolTitle", theme.bold(tool.name));

      const entries = Object.entries(args as Record<string, unknown>).filter(([, v]) => v !== undefined);
      if (entries.length === 0) {
        return new Text(title, 0, 0);
      }

      let text = title;
      let anyTruncated = false;
      const MAX_VALUE_LEN = 57;
      for (const [key, value] of entries) {
        const valueStr = formatParamValue(value);
        if (context.expanded) {
          text += `\n  ${theme.fg("dim", `${key}:`)} ${theme.fg("accent", valueStr)}`;
        } else {
          // Collapse to single line for compact view
          const singleLine = valueStr.replace(/\n/g, " ");
          if (singleLine.length > MAX_VALUE_LEN) {
            anyTruncated = true;
            text += `\n  ${theme.fg("dim", `${key}:`)} ${theme.fg("accent", `${singleLine.slice(0, MAX_VALUE_LEN)}...`)}`;
          } else {
            text += `\n  ${theme.fg("dim", `${key}:`)} ${theme.fg("accent", singleLine)}`;
          }
        }
      }
      if (!context.expanded && anyTruncated) {
        text += `${theme.fg("muted", "\n...")} ${keyHint("app.tools.expand", "to expand")}`;
      }
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

      if (expanded) {
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
      const validated = validateToolParams(schema, params);
      if (!validated.ok) {
        throw new Error(`Invalid parameters: ${validated.message}`);
      }

      const command = interpolateCommand(tool.command, validated.value);
      const { extraEnv, redact } = await resolveToolEnvironment(tool, { cwd: ctx.cwd, signal });

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
