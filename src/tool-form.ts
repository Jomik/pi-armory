export interface ToolFormResult {
  name: string;
  command: string;
  description: string;
  guidelines: string[];
  requiresApproval: boolean;
  destination: "project" | "global" | "session";
}

export type ToolFormState = ToolFormResult & {
  /** Optional title shown at top of form. Defaults to "Request Tool". */
  title?: string;
};

export interface ToolFormCallbacks {
  onRedraft?: (current: ToolFormResult, instruction: string) => Promise<Partial<ToolFormResult> | null>;
}

export interface ToolFormRejection {
  rejected: true;
  reason: string;
}

/** Minimal native-dialog UI surface required to drive the tool form. */
export interface ToolFormUI {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  editor(title: string, prefill?: string): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
}

const EDIT_GUIDELINE_RE = /^Edit guideline (\d+)$/;
const REMOVE_GUIDELINE_RE = /^Remove guideline (\d+)$/;

function formatGuidelinesForTitle(guidelines: string[]): string {
  if (guidelines.length === 0) return "  (none)";
  return guidelines.map((g, i) => `  ${i + 1}. ${g}`).join("\n");
}

/**
 * Drive tool review/editing via a repeated native select menu, falling back to
 * ui.input/ui.editor for individual field edits.
 */
export async function toolFormPanel(
  ui: ToolFormUI,
  initialState: ToolFormState,
  callbacks?: ToolFormCallbacks,
): Promise<ToolFormResult | ToolFormRejection> {
  let name = initialState.name;
  let command = initialState.command;
  let description = initialState.description;
  let guidelines = [...initialState.guidelines];
  let requiresApproval = initialState.requiresApproval;
  let destination = initialState.destination;
  const title = initialState.title ?? "Request Tool";

  function currentResult(): ToolFormResult {
    return { name, command, description, guidelines, requiresApproval, destination };
  }

  function menuTitle(): string {
    return [
      title,
      `Name: ${name}`,
      `Command: ${command}`,
      `Description: ${description}`,
      "Guidelines:",
      formatGuidelinesForTitle(guidelines),
      `Approval required: ${requiresApproval ? "Yes" : "No"}`,
      `Destination: ${destination}`,
    ].join("\n");
  }

  for (;;) {
    const options: string[] = ["Save", "Edit name", "Edit command", "Edit description"];
    guidelines.forEach((_, i) => {
      options.push(`Edit guideline ${i + 1}`);
      options.push(`Remove guideline ${i + 1}`);
    });
    options.push("Add guideline", "Set approval", "Set destination");
    if (callbacks?.onRedraft) options.push("Re-draft");
    options.push("Reject");

    const choice = await ui.select(menuTitle(), options);

    if (choice === "Save") {
      return currentResult();
    }

    if (choice === "Edit name") {
      const value = await ui.input("Name", name);
      if (value !== undefined) name = value;
      continue;
    }

    if (choice === "Edit command") {
      const value = await ui.editor("Command", command);
      if (value !== undefined) command = value;
      continue;
    }

    if (choice === "Edit description") {
      const value = await ui.editor("Description", description);
      if (value !== undefined) description = value;
      continue;
    }

    if (choice === "Add guideline") {
      const value = await ui.input("New guideline");
      if (value !== undefined) {
        const trimmed = value.trim();
        if (trimmed) guidelines = [...guidelines, trimmed];
      }
      continue;
    }

    if (choice === "Set approval") {
      const value = await ui.select("Require approval?", ["Yes", "No"]);
      if (value === "Yes") requiresApproval = true;
      else if (value === "No") requiresApproval = false;
      continue;
    }

    if (choice === "Set destination") {
      const value = await ui.select("Destination", ["session", "project", "global"]);
      if (value === "session" || value === "project" || value === "global") destination = value;
      continue;
    }

    if (choice === "Re-draft" && callbacks?.onRedraft) {
      const instruction = await ui.input("Re-draft instruction");
      if (instruction === undefined) continue;
      try {
        const revised = await callbacks.onRedraft(currentResult(), instruction);
        if (revised) {
          if (revised.name !== undefined) name = revised.name;
          if (revised.command !== undefined) command = revised.command;
          if (revised.description !== undefined) description = revised.description;
          if (revised.guidelines !== undefined) guidelines = revised.guidelines;
          if (revised.requiresApproval !== undefined) requiresApproval = revised.requiresApproval;
          if (revised.destination !== undefined) destination = revised.destination;
        }
      } catch {
        ui.notify("Re-draft failed", "error");
      }
      continue;
    }

    if (choice === "Reject") {
      const reason = await ui.input("Rejection reason");
      if (reason === undefined) continue; // cancelled — back to review
      return { rejected: true, reason };
    }

    const editMatch = choice !== undefined ? EDIT_GUIDELINE_RE.exec(choice) : null;
    if (editMatch?.[1]) {
      const index = Number(editMatch[1]) - 1;
      if (index < 0 || index >= guidelines.length) {
        return { rejected: true, reason: "" };
      }
      const value = await ui.input(`Guideline ${index + 1}`, guidelines[index]);
      if (value !== undefined) {
        const trimmed = value.trim();
        if (trimmed) {
          guidelines = guidelines.map((g, i) => (i === index ? trimmed : g));
        } else {
          guidelines = guidelines.filter((_, i) => i !== index);
        }
      }
      continue;
    }

    const removeMatch = choice !== undefined ? REMOVE_GUIDELINE_RE.exec(choice) : null;
    if (removeMatch?.[1]) {
      const index = Number(removeMatch[1]) - 1;
      if (index < 0 || index >= guidelines.length) {
        return { rejected: true, reason: "" };
      }
      guidelines = guidelines.filter((_, i) => i !== index);
      continue;
    }

    // Menu cancellation (choice === undefined) or an unexpected response fails closed.
    return { rejected: true, reason: "" };
  }
}
