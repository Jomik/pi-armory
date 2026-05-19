import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Editor, Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { type ArmoryTool, saveConfig } from "./config.js";
import { registerArmoryTool } from "./register-tool.js";

interface RequestToolResult {
  name: string;
  command: string;
  description: string;
  guidelines: string[];
  requiresApproval: boolean;
  destination: "project" | "global";
}

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

export function registerRequestTool(pi: ExtensionAPI, projectRoot: string): void {
  pi.registerTool({
    name: "request_tool",
    label: "Request Tool",
    description:
      "Request a new armory tool to be registered. Presents a form for the user to review, edit, and approve the proposed tool before it is added to the armory.",
    promptSnippet: "request_tool: propose a new named shell-command tool for approval",
    parameters: Type.Object({
      name: Type.String({ description: "Tool name (lowercase, underscores)" }),
      command: Type.String({ description: "Shell command to execute" }),
      description: Type.String({ description: "What this tool does (shown to LLM)" }),
      requires_approval: Type.Optional(Type.Boolean({ description: "Require human approval before each execution" })),
      guidelines: Type.Optional(
        Type.Array(Type.String(), { description: "Usage guidelines for the agent (behavioral instructions)" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        return {
          content: [{ type: "text", text: "request_tool requires interactive mode" }],
          details: undefined,
        };
      }

      const result = await ctx.ui.custom<RequestToolResult | null>((tui, theme, _keybindings, done) => {
        let focus = 0; // 0=name, 1=command, 2=description, 3=guidelines, 4=approval, 5=destination
        let requiresApproval = params.requires_approval ?? false;
        let destination: "project" | "global" = "project";
        let guidelines: string[] = params.guidelines?.slice() ?? [];

        const editorTheme = {
          borderColor: (s: string) => theme.fg("border", s),
          selectList: {
            selectedPrefix: (s: string) => theme.fg("accent", s),
            selectedText: (s: string) => theme.fg("accent", s),
            description: (s: string) => theme.fg("muted", s),
            scrollInfo: (s: string) => theme.fg("dim", s),
            noMatch: (s: string) => theme.fg("muted", s),
          },
        };

        const nameEditor = new Editor(tui, editorTheme);
        const commandEditor = new Editor(tui, editorTheme);
        const descEditor = new Editor(tui, editorTheme);
        const guidelinesEditor = new Editor(tui, editorTheme);

        nameEditor.setText(params.name);
        commandEditor.setText(params.command);
        descEditor.setText(params.description);

        const textEditors = [nameEditor, commandEditor, descEditor];

        function currentResult(): RequestToolResult {
          return {
            name: nameEditor.getText(),
            command: commandEditor.getText(),
            description: descEditor.getText(),
            guidelines,
            requiresApproval,
            destination,
          };
        }

        return {
          invalidate() {
            for (const ed of textEditors) ed.invalidate();
            guidelinesEditor.invalidate();
          },

          render(width: number): string[] {
            const lines: string[] = [];
            const maxW = Math.min(width, 100);
            const hr = theme.fg("accent", "─".repeat(maxW));
            const LABEL = 14;
            const fieldWidth = Math.max(maxW - LABEL - 3, 8);

            // Set focused state on editors for cursor visibility
            for (let i = 0; i < 3; i++) {
              textEditors[i].focused = focus === i;
            }
            guidelinesEditor.focused = focus === 3;

            lines.push(hr);
            lines.push(` ${theme.fg("accent", theme.bold("Request Tool"))}`);
            lines.push("");

            const fieldLabels = ["Name:", "Command:", "Description:"];
            for (let i = 0; i < 3; i++) {
              const label = (fieldLabels[i] ?? "").padEnd(LABEL);
              if (focus === i) {
                const edLines = textEditors[i].render(fieldWidth);
                const midLine = edLines.length > 1 ? Math.floor(edLines.length / 2) : 0;
                for (let j = 0; j < edLines.length; j++) {
                  if (j === midLine) {
                    lines.push(` ${theme.fg("accent", label)} ${edLines[j]}`);
                  } else {
                    lines.push(` ${" ".repeat(LABEL)} ${edLines[j]}`);
                  }
                }
              } else {
                const val = truncateToWidth(textEditors[i].getText(), fieldWidth);
                lines.push(` ${theme.fg("muted", label)} ${theme.fg("text", val)}`);
              }
            }

            lines.push("");

            // Guidelines field
            const guidelinesLabel = "Guidelines:".padEnd(LABEL);
            if (focus === 3) {
              for (let i = 0; i < guidelines.length; i++) {
                const prefix = i === 0 ? theme.fg("accent", guidelinesLabel) : " ".repeat(LABEL);
                lines.push(` ${prefix} ${theme.fg("text", `- ${guidelines[i]}`)}`);
              }
              const edLines = guidelinesEditor.render(fieldWidth);
              const edMid = edLines.length > 1 ? Math.floor(edLines.length / 2) : 0;
              for (let j = 0; j < edLines.length; j++) {
                if (j === edMid) {
                  const prefix = guidelines.length === 0 ? theme.fg("accent", guidelinesLabel) : " ".repeat(LABEL);
                  lines.push(` ${prefix} ${edLines[j]}`);
                } else {
                  lines.push(` ${" ".repeat(LABEL)} ${edLines[j]}`);
                }
              }
            } else if (guidelines.length === 0) {
              lines.push(` ${theme.fg("muted", guidelinesLabel)} ${theme.fg("dim", "(none)")}`);
            } else {
              for (let i = 0; i < guidelines.length; i++) {
                const prefix = i === 0 ? theme.fg("muted", guidelinesLabel) : " ".repeat(LABEL);
                lines.push(` ${prefix} ${theme.fg("text", `- ${guidelines[i]}`)}`);
              }
            }

            lines.push("");

            // Approval toggle
            const approvalLabel = "Approval:".padEnd(LABEL);
            const noMark = requiresApproval ? "○" : "●";
            const yesMark = requiresApproval ? "●" : "○";
            lines.push(
              ` ${focus === 4 ? theme.fg("accent", approvalLabel) : theme.fg("muted", approvalLabel)} ${theme.fg("text", `${noMark} No  ${yesMark} Yes`)}`,
            );

            // Destination toggle
            const destLabel = "Destination:".padEnd(LABEL);
            const projMark = destination === "project" ? "●" : "○";
            const globMark = destination === "global" ? "●" : "○";
            lines.push(
              ` ${focus === 5 ? theme.fg("accent", destLabel) : theme.fg("muted", destLabel)} ${theme.fg("text", `${projMark} Project  ${globMark} Global`)}`,
            );

            lines.push("");
            let hint: string;
            if (focus < 3) {
              hint = "Enter next field  •  Esc reject  •  Tab next field";
            } else if (focus === 3) {
              hint = "Enter add guideline  •  Backspace remove last  •  Esc reject  •  Tab next field";
            } else {
              hint = "Enter approve  •  Esc reject  •  ←→/Space toggle";
            }
            lines.push(` ${theme.fg("dim", hint)}`);
            lines.push(hr);

            return lines;
          },

          handleInput(data: string) {
            if (matchesKey(data, Key.escape)) {
              done(null);
              return;
            }

            if (matchesKey(data, Key.up)) {
              focus = (focus + 5) % 6;
              tui.requestRender();
              return;
            }

            if (matchesKey(data, Key.down) || matchesKey(data, Key.tab)) {
              focus = (focus + 1) % 6;
              tui.requestRender();
              return;
            }

            if (matchesKey(data, Key.enter)) {
              if (focus < 3) {
                // Advance from text editor to next field
                focus = (focus + 1) % 6;
                tui.requestRender();
              } else if (focus === 3) {
                // Guidelines field: add guideline or advance
                const text = guidelinesEditor.getText().trim();
                if (text) {
                  guidelines = [...guidelines, text];
                  guidelinesEditor.setText("");
                  tui.requestRender();
                } else {
                  focus = 4;
                  tui.requestRender();
                }
              } else {
                done(currentResult());
              }
              return;
            }

            // Guidelines field
            if (focus === 3) {
              if (matchesKey(data, Key.backspace) && guidelinesEditor.getText() === "" && guidelines.length > 0) {
                guidelines = guidelines.slice(0, -1);
                tui.requestRender();
                return;
              }
              guidelinesEditor.handleInput(data);
              tui.requestRender();
              return;
            }

            // Approval toggle
            if (focus === 4) {
              if (matchesKey(data, Key.space) || matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
                requiresApproval = !requiresApproval;
                tui.requestRender();
              }
              return;
            }

            // Destination toggle
            if (focus === 5) {
              if (matchesKey(data, Key.space) || matchesKey(data, Key.left) || matchesKey(data, Key.right)) {
                destination = destination === "project" ? "global" : "project";
                tui.requestRender();
              }
              return;
            }

            // Route to focused text editor
            textEditors[focus]?.handleInput(data);
            tui.requestRender();
          },
        };
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

      const tool: ArmoryTool = {
        name,
        command: result.command,
        description: result.description,
        ...(result.requiresApproval ? { requires_approval: true } : {}),
        ...(result.guidelines.length > 0 ? { guidelines: result.guidelines } : {}),
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
