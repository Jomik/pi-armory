import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { saveConfig } from "./config.js";
import { type DraftOutput, draftToolDefinition } from "./draft.js";
import { registerArmoryTool, sessionRegistry } from "./register-tool.js";
import { buildToolFromResult, resolveModel, showToolEditor } from "./shared.js";

export { extractPlaceholders } from "./shared.js";

export const RESERVED_NAMES = new Set(["request_tool"]);
export const VALID_NAME = /^[a-z][a-z0-9_]*$/;

export function normalizeName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .replace(/^[0-9_]+/, "");
}

export function registerRequestTool(pi: ExtensionAPI, projectRoot: string, draftModelName?: string): void {
  pi.registerTool({
    name: "request_tool",
    label: "Request Tool",
    description:
      "Request a new armory tool to be registered. Presents a form for the user to review, edit, and approve the proposed tool before it is added to the armory.",
    promptSnippet:
      "request_tool: propose a shell command to be registered as a reusable tool. A model will draft the full tool definition for human review.",
    promptGuidelines: [
      "Only call request_tool one at a time. Never make parallel request_tool calls.",
      "Include file contents in context when the command references custom scripts or config files.",
    ],
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to run (or approximate command)", minLength: 1 }),
      reasoning: Type.String({ description: "Why this tool is needed, what problem it solves", minLength: 1 }),
      context: Type.Optional(
        Type.String({ description: "Relevant context: file contents, script bodies, usage examples" }),
      ),
    }),
    renderCall(args, theme, _context) {
      let text = theme.fg("toolTitle", theme.bold("request_tool "));
      text += theme.fg("accent", args.command);
      if (args.reasoning) {
        text += `\n${theme.fg("dim", args.reasoning)}`;
      }
      return new Text(text, 0, 0);
    },

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        return {
          content: [{ type: "text", text: "request_tool requires interactive mode" }],
          details: undefined,
        };
      }

      // Resolve draft model: prefer configured "provider:modelId", fall back to session model
      let draftModel: Model<Api> | undefined;
      if (draftModelName) {
        draftModel = resolveModel(ctx.modelRegistry, draftModelName);
      }
      if (!draftModel) {
        draftModel = ctx.model as Model<Api> | undefined;
      }

      let drafted: DraftOutput | undefined;
      let draftRejectionReason: string | undefined;
      if (draftModel) {
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(draftModel);
        if (auth.ok) {
          const draftResult = await draftToolDefinition(
            draftModel,
            auth,
            { command: params.command, reasoning: params.reasoning, context: params.context },
            signal,
          );
          if ("rejected" in draftResult && draftResult.rejected) {
            draftRejectionReason = draftResult.reason;
          } else {
            drafted = draftResult as DraftOutput;
          }
        }
      }

      if (draftRejectionReason !== undefined) {
        const reason = draftRejectionReason ? `: ${draftRejectionReason}` : "";
        throw new Error(`Draft rejected${reason}`);
      }

      const result = await showToolEditor(
        ctx,
        {
          name: drafted?.name ?? "",
          command: drafted?.command ?? params.command,
          description: drafted?.description ?? params.reasoning,
          guidelines: drafted?.guidelines ?? [],
          requiresApproval: drafted?.requires_approval ?? false,
          destination: drafted?.destination ?? "session",
        },
        draftModelName,
        {
          command: params.command,
          reasoning: params.reasoning,
          ...(params.context ? { context: params.context } : {}),
        },
      );

      if ("rejected" in result) {
        const reason = result.reason ? `: ${result.reason}` : "";
        throw new Error(`User rejected${reason}`);
      }

      const name = normalizeName(result.name);

      if (!name || !VALID_NAME.test(name)) {
        return {
          content: [
            {
              type: "text",
              text: `Could not derive a valid tool name from '${result.name}'. Must contain at least one letter.`,
            },
          ],
          details: undefined,
        };
      }

      if (RESERVED_NAMES.has(name)) {
        return {
          content: [{ type: "text", text: `Cannot register tool with reserved name '${name}'.` }],
          details: undefined,
        };
      }

      const tool = buildToolFromResult({ ...result, name });

      if (result.destination !== "session") {
        await saveConfig(tool, result.destination, projectRoot);
        sessionRegistry.delete(tool.name);
      }
      registerArmoryTool(pi, tool);
      if (result.destination === "session") {
        sessionRegistry.set(tool.name, tool);
      }

      return {
        content: [
          {
            type: "text",
            text: `Tool registered as '${tool.name}'. You can use it next turn.`,
          },
        ],
        details: undefined,
        terminate: true,
      };
    },
  });
}
