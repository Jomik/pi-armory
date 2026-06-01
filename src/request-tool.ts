import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { saveConfig } from "./config.js";
import { type DraftOutput, draftToolDefinition } from "./draft.js";
import { registerArmoryTool } from "./register-tool.js";
import { buildToolFromResult, makeRedraftCallback, resolveModel } from "./shared.js";

export { extractPlaceholders } from "./shared.js";

import { type ToolFormCallbacks, type ToolFormRejection, type ToolFormResult, toolFormPanel } from "./tool-form.js";

const RESERVED_NAMES = new Set(["request_tool"]);
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
          try {
            const draftResult = await draftToolDefinition(
              draftModel,
              { apiKey: auth.apiKey ?? "", ...(auth.headers ? { headers: auth.headers } : {}) },
              { command: params.command, reasoning: params.reasoning, context: params.context },
              signal,
            );
            if ("rejected" in draftResult && draftResult.rejected) {
              draftRejectionReason = draftResult.reason;
            } else {
              drafted = draftResult as DraftOutput;
            }
          } catch (err) {
            if (err instanceof Error && err.name === "AbortError") throw err;
            // Draft failed — continue with raw input
          }
        }
      }

      if (draftRejectionReason !== undefined) {
        const reason = draftRejectionReason ? `: ${draftRejectionReason}` : "";
        throw new Error(`Draft rejected${reason}`);
      }

      const result = await ctx.ui.custom<ToolFormResult | ToolFormRejection>((tui, theme, _keybindings, done) => {
        const dm = draftModel;
        const formCallbacks: ToolFormCallbacks = {
          onRedraft: dm ? makeRedraftCallback(ctx, dm) : undefined,
        };
        return toolFormPanel(
          tui,
          theme,
          done,
          {
            name: drafted?.name ?? "",
            command: drafted?.command ?? params.command,
            description: drafted?.description ?? params.reasoning,
            guidelines: drafted?.guidelines ?? [],
            requiresApproval: drafted?.requires_approval ?? false,
            destination: drafted?.destination ?? "project",
          },
          formCallbacks,
        );
      });

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

      await saveConfig(tool, result.destination, projectRoot);
      registerArmoryTool(pi, tool);

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
