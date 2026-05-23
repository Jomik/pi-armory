import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type ArmoryTool, saveConfig } from "./config.js";
import { type DraftOutput, draftToolDefinition, reviseDraftDefinition } from "./draft.js";
import { registerArmoryTool } from "./register-tool.js";
import { type ToolFormCallbacks, type ToolFormResult, toolFormPanel } from "./tool-form.js";

const RESERVED_NAMES = new Set(["request_tool"]);
export const VALID_NAME = /^[a-z][a-z0-9_]*$/;

export function extractPlaceholders(command: string): string[] {
  const matches = command.matchAll(/\{\{(\w+)\}\}/g);
  return [...new Set([...matches].map((m) => m[1]))];
}

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
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to run (or approximate command)" }),
      usage: Type.Optional(Type.String({ description: "Why this tool is needed / when to use it" })),
    }),
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
        const colonIdx = draftModelName.indexOf(":");
        if (colonIdx > 0) {
          const provider = draftModelName.slice(0, colonIdx);
          const modelId = draftModelName.slice(colonIdx + 1);
          draftModel = ctx.modelRegistry.find(provider, modelId);
        }
      }
      if (!draftModel) {
        draftModel = ctx.model as Model<Api> | undefined;
      }

      let drafted: DraftOutput | undefined;
      if (draftModel) {
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(draftModel);
        if (auth.ok) {
          try {
            drafted = await draftToolDefinition(
              draftModel,
              { apiKey: auth.apiKey ?? "", ...(auth.headers ? { headers: auth.headers } : {}) },
              { command: params.command, usage: params.usage },
              signal,
            );
          } catch {
            // Draft failed — continue with raw input
          }
        }
      }

      const result = await ctx.ui.custom<ToolFormResult | null>((tui, theme, _keybindings, done) => {
        const dm = draftModel;
        const formCallbacks: ToolFormCallbacks = {
          onRedraft: dm
            ? async (current, instruction) => {
                const auth = await ctx.modelRegistry.getApiKeyAndHeaders(dm);
                if (!auth.ok) return null;
                const revised = await reviseDraftDefinition(
                  dm,
                  { apiKey: auth.apiKey ?? "", ...(auth.headers ? { headers: auth.headers } : {}) },
                  {
                    current: {
                      ...current,
                      requires_approval: current.requiresApproval,
                      parameters: drafted?.parameters ?? {},
                    },
                    instruction,
                  },
                  signal,
                );
                return {
                  name: revised.name,
                  command: revised.command,
                  description: revised.description,
                  guidelines: revised.guidelines,
                  requiresApproval: revised.requires_approval,
                  destination: revised.destination,
                };
              }
            : undefined,
        };
        return toolFormPanel(
          tui,
          theme,
          done,
          {
            name: drafted?.name ?? "",
            command: drafted?.command ?? params.command,
            description: drafted?.description ?? params.usage ?? "",
            guidelines: drafted?.guidelines ?? [],
            requiresApproval: drafted?.requires_approval ?? false,
            destination: drafted?.destination ?? "project",
          },
          formCallbacks,
        );
      });

      if (result === null) {
        return {
          content: [{ type: "text", text: "Tool request rejected by user." }],
          details: undefined,
        };
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

      const placeholders = extractPlaceholders(result.command);
      const tool: ArmoryTool = {
        name,
        command: result.command,
        description: result.description,
        ...(result.requiresApproval ? { requires_approval: true } : {}),
        ...(result.guidelines.length > 0 ? { guidelines: result.guidelines } : {}),
        ...(placeholders.length > 0
          ? {
              parameters: Object.fromEntries(
                placeholders.map((p) => [
                  p,
                  { type: "string" as const, description: drafted?.parameters[p]?.description },
                ]),
              ),
            }
          : {}),
      };

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
      };
    },
  });
}
