import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { Editor, Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { parsePlaceholders } from "./shared.js";

export interface ToolFormState {
  /** Optional title shown at top of form. Defaults to "Request Tool". */
  title?: string;
  name: string;
  command: string;
  description: string;
  guidelines: string[];
  requiresApproval: boolean;
  destination: "project" | "global";
}

export interface ToolFormCallbacks {
  onRedraft?: (current: ToolFormResult, instruction: string) => Promise<Partial<ToolFormResult> | null>;
}

export interface ToolFormResult {
  name: string;
  command: string;
  description: string;
  guidelines: string[];
  requiresApproval: boolean;
  destination: "project" | "global";
}

export function toolFormPanel(
  tui: TUI,
  theme: Theme,
  done: (result: ToolFormResult | null) => void,
  initialState: ToolFormState,
  callbacks?: ToolFormCallbacks,
): { invalidate(): void; render(width: number): string[]; handleInput(data: string): void } {
  let focus = 0; // 0=name, 1=command, 2=description, 3=guidelines, 4=approval, 5=destination
  let requiresApproval = initialState.requiresApproval;
  let destination: "project" | "global" = initialState.destination;
  let guidelines: string[] = initialState.guidelines;
  const title = initialState.title ?? "Request Tool";
  let mode: "normal" | "instruction" | "drafting" = "normal";
  let draftError: string | null = null;
  const maxFocus = callbacks?.onRedraft ? 6 : 5;

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
  const instructionEditor = new Editor(tui, editorTheme);

  nameEditor.setText(initialState.name);
  commandEditor.setText(initialState.command);
  descEditor.setText(initialState.description);

  const textEditors = [nameEditor, commandEditor, descEditor];

  function currentResult(): ToolFormResult {
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
      instructionEditor.invalidate();
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
      lines.push(` ${theme.fg("accent", theme.bold(title))}`);
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
          const wrapped = wrapTextWithAnsi(theme.fg("text", textEditors[i].getText()), fieldWidth);
          for (let j = 0; j < wrapped.length; j++) {
            if (j === 0) {
              lines.push(` ${theme.fg("muted", label)} ${wrapped[j]}`);
            } else {
              lines.push(` ${" ".repeat(LABEL)} ${wrapped[j]}`);
            }
          }
        }
      }

      lines.push("");

      // Guidelines field
      const guidelinesLabel = "Guidelines:".padEnd(LABEL);
      if (focus === 3) {
        for (let i = 0; i < guidelines.length; i++) {
          const prefix = i === 0 ? theme.fg("accent", guidelinesLabel) : " ".repeat(LABEL);
          const wrapped = wrapTextWithAnsi(theme.fg("text", `- ${guidelines[i]}`), fieldWidth);
          for (let j = 0; j < wrapped.length; j++) {
            lines.push(` ${j === 0 ? prefix : " ".repeat(LABEL)} ${wrapped[j]}`);
          }
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
          const wrapped = wrapTextWithAnsi(theme.fg("text", `- ${guidelines[i]}`), fieldWidth);
          for (let j = 0; j < wrapped.length; j++) {
            lines.push(` ${j === 0 ? prefix : " ".repeat(LABEL)} ${wrapped[j]}`);
          }
        }
      }

      lines.push("");

      // Parameters (read-only, auto-detected)
      const paramsLabel = "Parameters:".padEnd(LABEL);
      const placeholders = parsePlaceholders(commandEditor.getText());
      const paramsText =
        placeholders.length > 0
          ? placeholders
              .map((p) => {
                const prefix = p.variadic ? "..." : "";
                const suffix = p.optional ? "?" : "";
                return `${prefix}${p.name}${suffix}`;
              })
              .join(", ")
          : "(none)";
      lines.push(` ${theme.fg("muted", paramsLabel)} ${theme.fg("dim", paramsText)}`);

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

      // Re-draft button (focus 6)
      if (callbacks?.onRedraft) {
        lines.push("");
        const redraftLabel = "Re-draft:".padEnd(LABEL);
        if (mode === "drafting") {
          lines.push(` ${theme.fg("accent", redraftLabel)} ${theme.fg("dim", "⟳ Drafting...")}`);
        } else if (mode === "instruction") {
          instructionEditor.focused = true;
          const edLines = instructionEditor.render(fieldWidth);
          const midLine = edLines.length > 1 ? Math.floor(edLines.length / 2) : 0;
          for (let j = 0; j < edLines.length; j++) {
            if (j === midLine) {
              lines.push(` ${theme.fg("accent", redraftLabel)} ${edLines[j]}`);
            } else {
              lines.push(` ${" ".repeat(LABEL)} ${edLines[j]}`);
            }
          }
        } else if (focus === 6) {
          lines.push(` ${theme.fg("accent", redraftLabel)} ${theme.fg("accent", "● Press Enter to re-draft with AI")}`);
        } else {
          lines.push(` ${theme.fg("muted", redraftLabel)} ${theme.fg("dim", "Press Enter to re-draft with AI")}`);
        }
      }

      lines.push("");
      let hint: string;
      if (mode === "instruction") {
        hint = "Enter submit instruction  •  Esc cancel";
      } else if (mode === "drafting") {
        hint = "";
      } else {
        if (draftError) {
          lines.push(` ${theme.fg("error" as Parameters<typeof theme.fg>[0], draftError)}`);
        }
        if (focus < 3) {
          hint = "Enter next field  •  Esc reject  •  Tab next field";
        } else if (focus === 3) {
          hint = "Enter add guideline  •  Backspace remove last  •  Esc reject  •  Tab next field";
        } else if (focus === 6) {
          hint = "Enter re-draft  •  Esc reject  •  Tab next field";
        } else {
          hint = "Enter approve  •  Esc reject  •  ←→/Space toggle";
        }
      }
      lines.push(` ${theme.fg("dim", hint)}`);
      lines.push(hr);

      return lines.map((line) => truncateToWidth(line, width));
    },

    handleInput(data: string) {
      // In drafting mode, ignore all input
      if (mode === "drafting") return;

      // In instruction mode, handle instruction entry
      if (mode === "instruction") {
        if (matchesKey(data, Key.escape)) {
          mode = "normal";
          instructionEditor.setText("");
          tui.requestRender();
          return;
        }
        if (matchesKey(data, Key.enter)) {
          const instruction = instructionEditor.getText().trim();
          instructionEditor.setText("");
          mode = "drafting";
          tui.requestRender();
          const onRedraft = callbacks?.onRedraft;
          if (!onRedraft) return;
          onRedraft(currentResult(), instruction)
            .then((result) => {
              if (result) {
                if (result.name !== undefined) nameEditor.setText(result.name);
                if (result.command !== undefined) commandEditor.setText(result.command);
                if (result.description !== undefined) descEditor.setText(result.description);
                if (result.guidelines !== undefined) guidelines = result.guidelines;
                if (result.requiresApproval !== undefined) requiresApproval = result.requiresApproval;
                if (result.destination !== undefined) destination = result.destination;
              }
              mode = "normal";
              tui.requestRender();
            })
            .catch(() => {
              draftError = "Re-draft failed";
              mode = "normal";
              tui.requestRender();
            });
          return;
        }
        instructionEditor.handleInput(data);
        tui.requestRender();
        return;
      }

      if (matchesKey(data, Key.escape)) {
        done(null);
        return;
      }

      // Clear draftError on any keypress
      if (draftError) {
        draftError = null;
      }

      if (matchesKey(data, Key.up)) {
        focus = (focus + maxFocus) % (maxFocus + 1);
        tui.requestRender();
        return;
      }

      if (matchesKey(data, Key.down) || matchesKey(data, Key.tab)) {
        focus = (focus + 1) % (maxFocus + 1);
        tui.requestRender();
        return;
      }

      if (matchesKey(data, Key.enter)) {
        if (focus < 3) {
          // Advance from text editor to next field
          focus = (focus + 1) % (maxFocus + 1);
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
        } else if (focus === 6 && callbacks?.onRedraft) {
          // Enter re-draft instruction mode
          draftError = null;
          mode = "instruction";
          tui.requestRender();
        } else {
          // focus 4 or 5 — approve
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
}
