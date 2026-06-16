import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { saveConfig } from "./config.js";
import type { CandidateRequest, DraftInput, DraftOutput } from "./draft.js";
import { draftToolDefinition, generateCandidateRequests } from "./draft.js";
import { registerArmoryTool, sessionRegistry } from "./register-tool.js";
import { normalizeName, RESERVED_NAMES, VALID_NAME } from "./request-tool.js";
import { buildToolFromResult, resolveModel, showToolEditor } from "./shared.js";

// ---------------------------------------------------------------------------
// Project evidence gathering
// ---------------------------------------------------------------------------

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function gatherProjectEvidence(projectRoot: string): Promise<string> {
  const parts: string[] = [];

  // package.json scripts
  try {
    const raw = await readFile(path.join(projectRoot, "package.json"), "utf-8");
    const pkg = JSON.parse(raw) as { name?: string; scripts?: Record<string, string> };
    if (typeof pkg.name === "string") {
      parts.push(`Project name: ${pkg.name}`);
    }
    if (pkg.scripts && Object.keys(pkg.scripts).length > 0) {
      parts.push("package.json scripts:");
      for (const [k, v] of Object.entries(pkg.scripts)) {
        parts.push(`  ${k}: ${v}`);
      }
    }
  } catch {
    // no package.json
  }

  // Makefile — first 80 lines for target discovery
  try {
    const makefile = await readFile(path.join(projectRoot, "Makefile"), "utf-8");
    const lines = makefile.split("\n").slice(0, 80).join("\n");
    parts.push("\nMakefile (first 80 lines):");
    parts.push(lines);
  } catch {
    // no Makefile
  }

  // Cargo.toml — first 30 lines
  try {
    const cargo = await readFile(path.join(projectRoot, "Cargo.toml"), "utf-8");
    parts.push("\nCargo.toml (first 30 lines):");
    parts.push(cargo.split("\n").slice(0, 30).join("\n"));
  } catch {
    // no Cargo.toml
  }

  // Tooling config files present
  const toolingFiles = [
    "biome.json",
    ".eslintrc",
    ".eslintrc.json",
    ".eslintrc.js",
    ".eslintrc.yml",
    "jest.config.js",
    "jest.config.ts",
    "vitest.config.ts",
    "vitest.config.js",
    "vitest.config.mts",
    "tsconfig.json",
    "Dockerfile",
    "docker-compose.yml",
    "go.mod",
    "pyproject.toml",
    ".prettierrc",
    ".prettierrc.json",
  ];

  const present: string[] = [];
  for (const f of toolingFiles) {
    if (await fileExists(path.join(projectRoot, f))) {
      present.push(f);
    }
  }
  if (present.length > 0) {
    parts.push(`\nConfig/tooling files present: ${present.join(", ")}`);
  }

  // scripts/ directory listing
  try {
    const entries = await readdir(path.join(projectRoot, "scripts"));
    if (entries.length > 0) {
      parts.push(`\nscripts/ directory: ${entries.join(", ")}`);
    }
  } catch {
    // no scripts dir
  }

  // .github/workflows listing
  try {
    const workflows = await readdir(path.join(projectRoot, ".github", "workflows"));
    if (workflows.length > 0) {
      parts.push(`\n.github/workflows: ${workflows.join(", ")}`);
    }
  } catch {
    // no workflows
  }

  return parts.length > 0 ? parts.join("\n") : "(no project evidence found)";
}

// ---------------------------------------------------------------------------
// Candidate multi-select TUI panel
// ---------------------------------------------------------------------------

function candidateSelectorPanel(
  tui: TUI,
  theme: Theme,
  done: (result: CandidateRequest[] | null) => void,
  candidates: CandidateRequest[],
): { invalidate(): void; render(width: number): string[]; handleInput(data: string): void } {
  let cursor = 0;
  const selected = new Set<number>();

  return {
    invalidate() {},

    render(width: number): string[] {
      const lines: string[] = [];
      const maxW = Math.min(width, 100);
      const hr = theme.fg("accent", "─".repeat(maxW));

      lines.push(hr);
      lines.push(
        ` ${theme.fg("accent", theme.bold("Armory Onboarding"))}  ${theme.fg("dim", "select tools to draft")}`,
      );
      lines.push("");

      for (let i = 0; i < candidates.length; i++) {
        const c = candidates[i] as CandidateRequest;
        const isCursor = i === cursor;
        const isChecked = selected.has(i);
        const check = isChecked ? theme.fg("success", "[✓]") : theme.fg("dim", "[ ]");
        const arrow = isCursor ? theme.fg("accent", "❯") : " ";
        const labelStr = isCursor
          ? theme.fg("accent", c.label)
          : isChecked
            ? theme.fg("text", c.label)
            : theme.fg("dim", c.label);
        const cmdStr = theme.fg("muted", c.command);
        lines.push(truncateToWidth(` ${arrow} ${check}  ${labelStr}  ${cmdStr}`, maxW));
      }

      // Reasoning for focused candidate
      if (candidates.length > 0) {
        const focused = candidates[cursor] as CandidateRequest;
        lines.push("");
        const reasoningLines = wrapTextWithAnsi(theme.fg("dim", focused.reasoning), Math.max(maxW - 6, 20));
        for (const rLine of reasoningLines) {
          lines.push(`    ${rLine}`);
        }
      }

      lines.push("");
      lines.push(
        ` ${theme.fg("dim", "↑↓ navigate")}  ${theme.fg("dim", "Space toggle")}  ${theme.fg("dim", "a all")}  ${theme.fg("dim", "n none")}  ${theme.fg("dim", "Enter confirm")}  ${theme.fg("dim", "Esc cancel")}`,
      );
      lines.push(hr);

      return lines.map((l) => truncateToWidth(l, width));
    },

    handleInput(data: string): void {
      if (matchesKey(data, Key.escape)) {
        done(null);
        return;
      }

      if (matchesKey(data, Key.enter)) {
        done(
          Array.from(selected)
            .sort((a, b) => a - b)
            .map((i) => candidates[i] as CandidateRequest),
        );
        return;
      }

      if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
        if (candidates.length > 0) {
          cursor = (cursor - 1 + candidates.length) % candidates.length;
          tui.requestRender();
        }
        return;
      }

      if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
        if (candidates.length > 0) {
          cursor = (cursor + 1) % candidates.length;
          tui.requestRender();
        }
        return;
      }

      if (matchesKey(data, Key.space)) {
        if (selected.has(cursor)) {
          selected.delete(cursor);
        } else {
          selected.add(cursor);
        }
        tui.requestRender();
        return;
      }

      if (matchesKey(data, "a")) {
        for (let i = 0; i < candidates.length; i++) selected.add(i);
        tui.requestRender();
        return;
      }

      if (matchesKey(data, "n")) {
        selected.clear();
        tui.requestRender();
        return;
      }
    },
  };
}

async function showCandidateSelector(
  ctx: Pick<ExtensionCommandContext, "ui">,
  candidates: CandidateRequest[],
): Promise<CandidateRequest[] | null> {
  return ctx.ui.custom<CandidateRequest[] | null>(
    (tui, theme, _keybindings, done) => candidateSelectorPanel(tui, theme, done, candidates),
    { overlay: true, overlayOptions: { anchor: "center", width: "70%", maxHeight: "80%" } },
  );
}

// ---------------------------------------------------------------------------
// Per-candidate draft → editor → save/register (mirrors request_tool flow)
// ---------------------------------------------------------------------------

async function processCandidate(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  projectRoot: string,
  draftModelName: string | undefined,
  draftModel: Model<Api>,
  auth: { apiKey: string; headers?: Record<string, string> },
  candidate: CandidateRequest,
): Promise<"registered" | "skipped"> {
  const draftInput: DraftInput = {
    command: candidate.command,
    reasoning: candidate.reasoning,
    ...(candidate.context ? { context: candidate.context } : {}),
  };

  // Draft the tool definition
  let drafted: DraftOutput;
  try {
    const draftResult = await draftToolDefinition(draftModel, auth, draftInput);
    if ("rejected" in draftResult) {
      const reason = draftResult.reason ? `: ${draftResult.reason}` : "";
      ctx.ui.notify(`Skipped '${candidate.label}': draft rejected${reason}`, "info");
      return "skipped";
    }
    drafted = draftResult;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    ctx.ui.notify(`Skipped '${candidate.label}': draft failed`, "info");
    return "skipped";
  }

  // Show tool editor — same as request_tool
  const result = await showToolEditor(
    ctx,
    {
      title: `Onboard: ${candidate.label}`,
      name: drafted.name,
      command: drafted.command,
      description: drafted.description,
      guidelines: drafted.guidelines,
      requiresApproval: drafted.requires_approval,
      destination: drafted.destination,
    },
    draftModelName,
    draftInput,
  );

  if ("rejected" in result) {
    // User rejected — skip and continue to the next candidate
    return "skipped";
  }

  // Normalize and validate name
  const name = normalizeName(result.name);

  if (!name || !VALID_NAME.test(name)) {
    ctx.ui.notify(`Skipped '${candidate.label}': could not derive a valid tool name from '${result.name}'`, "info");
    return "skipped";
  }

  if (RESERVED_NAMES.has(name)) {
    ctx.ui.notify(`Skipped '${candidate.label}': '${name}' is a reserved name`, "info");
    return "skipped";
  }

  const tool = buildToolFromResult({ ...result, name });

  // Save and register — identical logic to request_tool
  if (result.destination !== "session") {
    await saveConfig(tool, result.destination, projectRoot);
    sessionRegistry.delete(tool.name);
  }
  registerArmoryTool(pi, tool);
  if (result.destination === "session") {
    sessionRegistry.set(tool.name, tool);
  }

  return "registered";
}

// ---------------------------------------------------------------------------
// Main onboard handler
// ---------------------------------------------------------------------------

export async function handleOnboard(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  projectRoot: string,
  draftModelName: string | undefined,
): Promise<void> {
  // Resolve draft model — try configured name first, fall back to session model
  let draftModel: Model<Api> | undefined;
  if (draftModelName) {
    draftModel = resolveModel(ctx.modelRegistry, draftModelName);
  }
  if (!draftModel) {
    draftModel = ctx.model as Model<Api> | undefined;
  }
  if (!draftModel) {
    ctx.ui.notify(
      "Onboarding requires a model. Configure draftModel in .pi/armory.json or ~/.pi/agent/armory.json, or start an active session.",
      "error",
    );
    return;
  }

  // Authenticate
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(draftModel);
  if (!auth.ok) {
    ctx.ui.notify("Cannot authenticate the draft model. Check your API key.", "error");
    return;
  }
  const authCreds = { apiKey: auth.apiKey ?? "", ...(auth.headers ? { headers: auth.headers } : {}) };

  // Gather project evidence
  ctx.ui.notify("Gathering project evidence…", "info");
  const evidence = await gatherProjectEvidence(projectRoot);

  // Generate candidate requests
  ctx.ui.notify("Generating tool candidates…", "info");
  let candidates: CandidateRequest[];
  try {
    candidates = await generateCandidateRequests(draftModel, authCreds, evidence);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") throw err;
    const msg = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`Failed to generate candidates: ${msg}`, "error");
    return;
  }

  if (candidates.length === 0) {
    ctx.ui.notify("No tool candidates could be suggested for this project.", "info");
    return;
  }

  // Multi-select
  const chosen = await showCandidateSelector(ctx, candidates);
  if (chosen === null) return; // user cancelled

  if (chosen.length === 0) {
    ctx.ui.notify("No candidates selected.", "info");
    return;
  }

  // Draft → review → save each selected candidate
  let registered = 0;
  let skipped = 0;

  for (const candidate of chosen) {
    const outcome = await processCandidate(pi, ctx, projectRoot, draftModelName, draftModel, authCreds, candidate);
    if (outcome === "registered") {
      registered++;
    } else {
      skipped++;
    }
  }

  // Summary notification
  if (skipped === 0) {
    ctx.ui.notify(
      `Onboarding complete: ${registered} tool${registered === 1 ? "" : "s"} registered. Available next turn.`,
      "info",
    );
  } else {
    ctx.ui.notify(`Onboarding complete: ${registered} registered, ${skipped} skipped.`, "info");
  }
}
