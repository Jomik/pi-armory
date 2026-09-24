import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArmoryTool } from "../src/config.js";
import type { CandidateRequest } from "../src/draft.js";

// ---------------------------------------------------------------------------
// handleOnboard — command flow
// ---------------------------------------------------------------------------

vi.mock("../src/config.js", () => ({
  getDestinationEnvSets: vi.fn().mockResolvedValue({}),
  saveConfig: vi.fn().mockResolvedValue({}),
}));

vi.mock("../src/register-tool.js", () => {
  const sessionRegistry = new Map<string, unknown>();
  return {
    registerArmoryTool: vi.fn(),
    sessionRegistry,
  };
});

vi.mock("../src/request-tool.js", () => ({
  normalizeName: vi.fn((name: string) =>
    name
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, "_")
      .replace(/[^a-z0-9_]/g, "")
      .replace(/^[0-9_]+/, ""),
  ),
  VALID_NAME: /^[a-z][a-z0-9_]*$/,
  RESERVED_NAMES: new Set(["request_tool"]),
}));

vi.mock("../src/draft.js", () => ({
  generateCandidateRequests: vi.fn(),
  draftToolDefinition: vi.fn(),
}));

vi.mock("../src/shared.js", () => ({
  resolveModel: vi.fn(),
  showToolEditor: vi.fn(),
  buildToolFromResult: vi.fn((r: Record<string, unknown>) => ({
    name: r.name,
    command: r.command,
    description: r.description,
  })),
  syncToolCondition: vi.fn(),
}));

import { getDestinationEnvSets, saveConfig } from "../src/config.js";
import { draftToolDefinition as mockDraft, generateCandidateRequests as mockGenerateCandidates } from "../src/draft.js";
import { handleOnboard } from "../src/onboard.js";
import { registerArmoryTool, sessionRegistry } from "../src/register-tool.js";
import { buildToolFromResult, resolveModel, showToolEditor, syncToolCondition } from "../src/shared.js";

// biome-ignore lint/suspicious/noExplicitAny: test mock
const fakeResolvedModel = {} as any;

const sampleCandidate: CandidateRequest = {
  label: "Run tests",
  command: "npm test",
  reasoning: "Run the test suite in CI.",
};

const sampleDraft = {
  name: "run_tests",
  command: "npm test",
  description: "Run the test suite",
  requires_approval: false,
  guidelines: [],
  destination: "project" as const,
};

const sampleEditorResult = {
  name: "run_tests",
  command: "npm test",
  description: "Run the test suite",
  guidelines: [],
  requiresApproval: false,
  destination: "project" as const,
};

function makePi() {
  return {
    registerTool: vi.fn(),
    getActiveTools: vi.fn(() => [] as string[]),
    setActiveTools: vi.fn(),
  };
}

function makeCtx(
  opts: {
    selectResponses?: (string | undefined)[];
    modelResolved?: boolean;
    authOk?: boolean;
    sessionModel?: unknown;
    mode?: string;
  } = {},
) {
  const { selectResponses = [], modelResolved = true, authOk = true, sessionModel = undefined, mode = "tui" } = opts;
  const selectQueue = [...selectResponses];

  vi.mocked(resolveModel).mockReturnValue(modelResolved ? fakeResolvedModel : undefined);

  const ctx = {
    mode,
    cwd: "/project",
    modelRegistry: {
      getApiKeyAndHeaders: vi.fn().mockResolvedValue(authOk ? { ok: true, apiKey: "test-key" } : { ok: false }),
    },
    model: sessionModel,
    ui: {
      notify: vi.fn(),
      select: vi.fn(async () => selectQueue.shift()),
    },
  };
  return ctx;
}

describe("handleOnboard — RPC mode guard", () => {
  afterEach(() => vi.clearAllMocks());

  it("notifies and returns early when ctx.mode is not 'tui' — no model/evidence/candidate work", async () => {
    const pi = makePi();
    const ctx = makeCtx({ mode: "rpc" });

    await handleOnboard(pi as never, ctx as never, "/project", "provider:model");

    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("TUI"), "error");
    expect(ctx.modelRegistry.getApiKeyAndHeaders).not.toHaveBeenCalled();
    expect(mockGenerateCandidates).not.toHaveBeenCalled();
  });
});

describe("handleOnboard — no model", () => {
  beforeEach(() => {
    vi.mocked(resolveModel).mockReturnValue(undefined);
    sessionRegistry.clear();
  });

  afterEach(() => vi.clearAllMocks());

  it("notifies error and returns when no draft model configured and no session model", async () => {
    const pi = makePi();
    const ctx = makeCtx({ modelResolved: false, sessionModel: undefined });

    await handleOnboard(pi as never, ctx as never, "/project", undefined);

    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("requires a model"), "error");
    expect(mockGenerateCandidates).not.toHaveBeenCalled();
  });

  it("uses session model as fallback when draftModelName is undefined", async () => {
    // resolveModel won't be called (no draftModelName), but session model exists
    const pi = makePi();
    const ctx = makeCtx({ sessionModel: fakeResolvedModel });
    vi.mocked(mockGenerateCandidates).mockResolvedValue([]);

    await handleOnboard(pi as never, ctx as never, "/project", undefined);

    // Should reach candidate generation (no model error)
    expect(mockGenerateCandidates).toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("No tool candidates"), "info");
  });
});

describe("handleOnboard — auth failure", () => {
  afterEach(() => vi.clearAllMocks());

  it("notifies error when model auth fails", async () => {
    const pi = makePi();
    const ctx = makeCtx({ modelResolved: true, authOk: false });

    await handleOnboard(pi as never, ctx as never, "/project", "provider:model");

    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("authenticate"), "error");
    expect(mockGenerateCandidates).not.toHaveBeenCalled();
  });
});

describe("handleOnboard — candidate generation failures", () => {
  beforeEach(() => sessionRegistry.clear());
  afterEach(() => vi.clearAllMocks());

  it("notifies error when generateCandidateRequests throws (malformed output)", async () => {
    const pi = makePi();
    const ctx = makeCtx();
    vi.mocked(mockGenerateCandidates).mockRejectedValue(new Error("Model returned malformed JSON for candidates"));

    await handleOnboard(pi as never, ctx as never, "/project", "provider:model");

    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Failed to generate candidates"), "error");
    expect(registerArmoryTool).not.toHaveBeenCalled();
  });

  it("notifies and returns when candidates list is empty", async () => {
    const pi = makePi();
    const ctx = makeCtx();
    vi.mocked(mockGenerateCandidates).mockResolvedValue([]);

    await handleOnboard(pi as never, ctx as never, "/project", "provider:model");

    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("No tool candidates"), "info");
    expect(ctx.ui.select).not.toHaveBeenCalled();
  });
});

describe("handleOnboard — multi-select", () => {
  beforeEach(() => {
    sessionRegistry.clear();
    vi.mocked(mockGenerateCandidates).mockResolvedValue([sampleCandidate]);
  });

  afterEach(() => vi.clearAllMocks());

  it("returns without registering tools when multi-select is cancelled", async () => {
    const pi = makePi();
    const ctx = makeCtx({ selectResponses: ["Cancel"] });

    await handleOnboard(pi as never, ctx as never, "/project", "provider:model");

    expect(registerArmoryTool).not.toHaveBeenCalled();
    expect(mockDraft).not.toHaveBeenCalled();
  });

  it("fails closed and returns when select returns an unexpected/undefined response", async () => {
    const pi = makePi();
    const ctx = makeCtx({ selectResponses: [undefined] });

    await handleOnboard(pi as never, ctx as never, "/project", "provider:model");

    expect(registerArmoryTool).not.toHaveBeenCalled();
    expect(mockDraft).not.toHaveBeenCalled();
  });

  it("notifies when confirming with no candidates toggled (empty selection)", async () => {
    const pi = makePi();
    const ctx = makeCtx({ selectResponses: ["Confirm"] });

    await handleOnboard(pi as never, ctx as never, "/project", "provider:model");

    expect(ctx.ui.notify).toHaveBeenCalledWith("No candidates selected.", "info");
    expect(registerArmoryTool).not.toHaveBeenCalled();
  });

  it("toggles a candidate on then off, leaving selection empty on confirm", async () => {
    const pi = makePi();
    const ctx = makeCtx({ selectResponses: ["Toggle 1", "Toggle 1", "Confirm"] });

    await handleOnboard(pi as never, ctx as never, "/project", "provider:model");

    expect(ctx.ui.notify).toHaveBeenCalledWith("No candidates selected.", "info");
    expect(registerArmoryTool).not.toHaveBeenCalled();
  });

  it("selects a candidate via toggle then confirms", async () => {
    vi.mocked(mockDraft).mockResolvedValue(sampleDraft);
    vi.mocked(showToolEditor).mockResolvedValue({ rejected: true, reason: "" });

    const pi = makePi();
    const ctx = makeCtx({ selectResponses: ["Toggle 1", "Confirm"] });

    await handleOnboard(pi as never, ctx as never, "/project", "provider:model");

    expect(mockDraft).toHaveBeenCalledTimes(1);
  });

  it("selects all candidates via 'Select all' then confirms", async () => {
    const secondCandidate: CandidateRequest = { label: "Lint", command: "biome check", reasoning: "Lint code." };
    vi.mocked(mockGenerateCandidates).mockResolvedValue([sampleCandidate, secondCandidate]);
    vi.mocked(mockDraft).mockResolvedValue(sampleDraft);
    vi.mocked(showToolEditor).mockResolvedValue({ rejected: true, reason: "" });

    const pi = makePi();
    const ctx = makeCtx({ selectResponses: ["Select all", "Confirm"] });

    await handleOnboard(pi as never, ctx as never, "/project", "provider:model");

    expect(mockDraft).toHaveBeenCalledTimes(2);
  });

  it("clears a selection via 'Clear all' before confirming", async () => {
    const pi = makePi();
    const ctx = makeCtx({ selectResponses: ["Select all", "Clear all", "Confirm"] });

    await handleOnboard(pi as never, ctx as never, "/project", "provider:model");

    expect(ctx.ui.notify).toHaveBeenCalledWith("No candidates selected.", "info");
    expect(mockDraft).not.toHaveBeenCalled();
  });

  it("presents every candidate's selected state, label, command, and reasoning in the title", async () => {
    const secondCandidate: CandidateRequest = { label: "Lint", command: "biome check", reasoning: "Lint code." };
    vi.mocked(mockGenerateCandidates).mockResolvedValue([sampleCandidate, secondCandidate]);

    const pi = makePi();
    const ctx = makeCtx({ selectResponses: ["Toggle 1", "Cancel"] });

    await handleOnboard(pi as never, ctx as never, "/project", "provider:model");

    const calls = vi.mocked(ctx.ui.select).mock.calls as unknown as [string, string[]][];
    const firstTitle = calls[0]?.[0];
    expect(firstTitle).toContain("[ ] 1. Run tests");
    expect(firstTitle).toContain("Command: npm test");
    expect(firstTitle).toContain("Reasoning: Run the test suite in CI.");
    expect(firstTitle).toContain("[ ] 2. Lint");
    expect(firstTitle).toContain("Command: biome check");
    expect(firstTitle).toContain("Reasoning: Lint code.");

    const secondTitle = calls[1]?.[0];
    expect(secondTitle).toContain("[x] 1. Run tests");
    expect(secondTitle).toContain("[ ] 2. Lint");

    const firstOptions = calls[0]?.[1];
    expect(firstOptions).toEqual(["Toggle 1", "Toggle 2", "Select all", "Clear all", "Confirm", "Cancel"]);
  });
});

describe("handleOnboard — per-candidate flow", () => {
  beforeEach(() => {
    sessionRegistry.clear();
    vi.mocked(getDestinationEnvSets).mockReset().mockResolvedValue({});
    vi.mocked(saveConfig).mockReset().mockResolvedValue({});
    vi.mocked(mockGenerateCandidates).mockResolvedValue([sampleCandidate]);
    vi.mocked(mockDraft).mockResolvedValue(sampleDraft);
  });

  afterEach(() => vi.clearAllMocks());

  it("drafts, shows editor, and registers an approved tool with its destination env sets", async () => {
    const builtTool = { name: "run_tests", command: "npm test", description: "Run the test suite" };
    const envSets = { common: { TOKEN: "secret" } };
    vi.mocked(getDestinationEnvSets).mockImplementation(async (dest) => (dest === "project" ? envSets : {}));
    vi.mocked(saveConfig).mockResolvedValue(envSets);
    vi.mocked(showToolEditor).mockResolvedValue(sampleEditorResult);
    vi.mocked(buildToolFromResult).mockReturnValue(builtTool);

    const pi = makePi();
    const ctx = makeCtx({ selectResponses: ["Toggle 1", "Confirm"] });

    await handleOnboard(pi as never, ctx as never, "/project", "provider:model");

    expect(mockDraft).toHaveBeenCalledWith(
      fakeResolvedModel,
      expect.objectContaining({ apiKey: "test-key" }),
      expect.objectContaining({ command: "npm test", reasoning: sampleCandidate.reasoning }),
    );
    expect(showToolEditor).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ title: "Onboard: Run tests", name: "run_tests" }),
      "provider:model",
      expect.objectContaining({ command: "npm test" }),
    );
    expect(saveConfig).toHaveBeenCalledWith(builtTool, "project", "/project", undefined, envSets, true);
    expect(getDestinationEnvSets).toHaveBeenCalledWith("project", "/project");
    expect(registerArmoryTool).toHaveBeenCalledWith(pi, builtTool, envSets);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("1 tool registered"), "info");
  });

  it("registers to session when destination is session — uses sessionRegistry", async () => {
    const sessionResult = { ...sampleEditorResult, destination: "session" as const };
    const builtTool = { name: "run_tests", command: "npm test", description: "Run the test suite" };
    vi.mocked(showToolEditor).mockResolvedValue(sessionResult);
    vi.mocked(buildToolFromResult).mockReturnValue(builtTool);

    const pi = makePi();
    const ctx = makeCtx({ selectResponses: ["Toggle 1", "Confirm"] });

    await handleOnboard(pi as never, ctx as never, "/project", "provider:model");

    expect(saveConfig).not.toHaveBeenCalled();
    expect(buildToolFromResult).toHaveBeenCalledWith(expect.objectContaining({ destination: "session", envFrom: [] }));
    expect(registerArmoryTool).toHaveBeenCalledWith(pi, builtTool);
    expect(sessionRegistry.get("run_tests")).toEqual(builtTool);
  });

  it.each([
    "project",
    "global",
  ] as const)("passes %s selection through save and immediate registration", async (destination) => {
    const displayed = { common: { TOKEN: "value" } };
    const saved = { ...displayed, later: { X: "new" } };
    vi.mocked(getDestinationEnvSets).mockImplementation(async (scope) => (scope === destination ? displayed : {}));
    vi.mocked(saveConfig).mockResolvedValue(saved);
    vi.mocked(showToolEditor).mockResolvedValue({ ...sampleEditorResult, destination, envFrom: ["common"] });
    const tool: ArmoryTool = { name: "run_tests", command: "npm test", description: "Run tests", envFrom: ["common"] };
    vi.mocked(buildToolFromResult).mockReturnValue(tool);
    const pi = makePi();
    const ctx = makeCtx({ selectResponses: ["Toggle 1", "Confirm"] });
    await handleOnboard(pi as never, ctx as never, "/project", "provider:model");
    expect(showToolEditor).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        envSets: {
          project: destination === "project" ? displayed : {},
          global: destination === "global" ? displayed : {},
        },
      }),
      "provider:model",
      expect.anything(),
    );
    expect(saveConfig).toHaveBeenCalledWith(tool, destination, "/project", undefined, displayed, true);
    expect(registerArmoryTool).toHaveBeenCalledWith(pi, tool, saved);
    expect(getDestinationEnvSets).toHaveBeenCalledTimes(2);
  });

  it("allows a valid destination despite invalid unrelated config; failed save leaves registries alone", async () => {
    vi.mocked(getDestinationEnvSets).mockImplementation(async (scope) => {
      if (scope === "project") throw new Error("Invalid config");
      return { common: { TOKEN: "value" } };
    });
    vi.mocked(saveConfig).mockRejectedValue(new Error("Selected env set changed; reload before saving"));
    vi.mocked(showToolEditor).mockResolvedValue({ ...sampleEditorResult, destination: "global", envFrom: ["common"] });
    vi.mocked(buildToolFromResult).mockReturnValue({
      name: "run_tests",
      command: "npm test",
      description: "Run tests",
      envFrom: ["common"],
    });
    sessionRegistry.set("other_tool", { name: "other_tool", command: "echo old", description: "Old tool" });
    const pi = makePi();
    const ctx = makeCtx({ selectResponses: ["Toggle 1", "Confirm"] });
    await handleOnboard(pi as never, ctx as never, "/project", "provider:model");
    expect(showToolEditor).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ envSets: { project: {}, global: { common: { TOKEN: "value" } } } }),
      "provider:model",
      expect.anything(),
    );
    expect(saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ envFrom: ["common"] }),
      "global",
      "/project",
      undefined,
      { common: { TOKEN: "value" } },
      true,
    );
    expect(registerArmoryTool).not.toHaveBeenCalled();
    expect(sessionRegistry.get("other_tool")).toEqual({
      name: "other_tool",
      command: "echo old",
      description: "Old tool",
    });
    expect(syncToolCondition).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith("Skipped 'Run tests': save failed", "info");
    expect(ctx.ui.notify).toHaveBeenCalledWith("Onboarding complete: 0 registered, 1 skipped.", "info");
    expect(vi.mocked(ctx.ui.notify).mock.calls.flat().join(" ")).not.toContain("Selected env set changed");
  });

  it("skips a normalized session name collision and continues the batch", async () => {
    const secondCandidate: CandidateRequest = { label: "Lint", command: "biome check", reasoning: "Lint code." };
    const oldTool = { name: "run_tests", command: "echo existing", description: "Existing tool" };
    const lintTool = { name: "lint", command: "biome check", description: "Lint" };
    sessionRegistry.set("run_tests", oldTool);
    vi.mocked(mockGenerateCandidates).mockResolvedValue([sampleCandidate, secondCandidate]);
    vi.mocked(showToolEditor)
      .mockResolvedValueOnce({ ...sampleEditorResult, name: "Run Tests", destination: "session" })
      .mockResolvedValueOnce({ ...sampleEditorResult, name: "lint", destination: "session" });
    vi.mocked(buildToolFromResult).mockReturnValue(lintTool);
    const pi = makePi();
    const ctx = makeCtx({ selectResponses: ["Select all", "Confirm"] });
    await handleOnboard(pi as never, ctx as never, "/project", "provider:model");
    expect(saveConfig).not.toHaveBeenCalled();
    expect(buildToolFromResult).toHaveBeenCalledTimes(1);
    expect(sessionRegistry.get("run_tests")).toBe(oldTool);
    expect(sessionRegistry.get("lint")).toBe(lintTool);
    expect(registerArmoryTool).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Skipped 'Run tests': tool name already used by a session tool", "info");
    expect(ctx.ui.notify).toHaveBeenCalledWith("Onboarding complete: 1 registered, 1 skipped.", "info");
  });

  it("skips a persisted candidate colliding with a session tool before saving", async () => {
    const oldTool = { name: "run_tests", command: "echo existing", description: "Existing tool" };
    sessionRegistry.set("run_tests", oldTool);
    vi.mocked(showToolEditor).mockResolvedValue(sampleEditorResult);
    const pi = makePi();
    const ctx = makeCtx({ selectResponses: ["Toggle 1", "Confirm"] });
    await handleOnboard(pi as never, ctx as never, "/project", "provider:model");
    expect(saveConfig).not.toHaveBeenCalled();
    expect(registerArmoryTool).not.toHaveBeenCalled();
    expect(sessionRegistry.get("run_tests")).toBe(oldTool);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Skipped 'Run tests': tool name already used by a session tool", "info");
  });

  it("continues after a same-destination persisted createOnly collision without replacing the existing tool", async () => {
    const secondCandidate: CandidateRequest = { label: "Lint", command: "biome check", reasoning: "Lint code." };
    const lintTool = { name: "lint", command: "biome check", description: "Lint the codebase" };
    const oldTool = { name: "old", command: "echo old", description: "Old tool" };
    const savedFiles = new Map<string, unknown>([["run_tests", oldTool]]);
    sessionRegistry.set("other_tool", oldTool);
    vi.mocked(mockGenerateCandidates).mockResolvedValue([sampleCandidate, secondCandidate]);
    vi.mocked(mockDraft)
      .mockResolvedValueOnce(sampleDraft)
      .mockResolvedValueOnce({ ...sampleDraft, name: "lint", command: "biome check" });
    vi.mocked(showToolEditor)
      .mockResolvedValueOnce(sampleEditorResult)
      .mockResolvedValueOnce({ ...sampleEditorResult, name: "lint", command: "biome check" });
    vi.mocked(buildToolFromResult)
      .mockReturnValueOnce({ name: "run_tests", command: "npm test", description: "Run tests" })
      .mockReturnValueOnce(lintTool);
    vi.mocked(saveConfig)
      .mockRejectedValueOnce(new Error("Tool run_tests already exists; secret resolver output"))
      .mockImplementationOnce(async (tool) => {
        savedFiles.set(tool.name, tool);
        return {};
      });

    const pi = makePi();
    const ctx = makeCtx({ selectResponses: ["Select all", "Confirm"] });
    await handleOnboard(pi as never, ctx as never, "/project", "provider:model");

    expect(saveConfig).toHaveBeenCalledTimes(2);
    expect(saveConfig).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ name: "run_tests" }),
      "project",
      "/project",
      undefined,
      {},
      true,
    );
    expect(saveConfig).toHaveBeenNthCalledWith(2, lintTool, "project", "/project", undefined, {}, true);
    expect(savedFiles.get("run_tests")).toBe(oldTool);
    expect(savedFiles.get("lint")).toBe(lintTool);
    expect(sessionRegistry.get("other_tool")).toBe(oldTool);
    expect(registerArmoryTool).toHaveBeenCalledTimes(1);
    expect(registerArmoryTool).toHaveBeenCalledWith(pi, lintTool, {});
    expect(syncToolCondition).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Skipped 'Run tests': save failed", "info");
    expect(ctx.ui.notify).toHaveBeenCalledWith("Onboarding complete: 1 registered, 1 skipped.", "info");
    expect(vi.mocked(ctx.ui.notify).mock.calls.flat().join(" ")).not.toContain("secret resolver output");
  });

  it("rethrows save cancellation without registering or summarizing", async () => {
    const abort = new Error("cancelled");
    abort.name = "AbortError";
    vi.mocked(saveConfig).mockRejectedValue(abort);
    vi.mocked(showToolEditor).mockResolvedValue(sampleEditorResult);
    const pi = makePi();
    const ctx = makeCtx({ selectResponses: ["Toggle 1", "Confirm"] });

    await expect(handleOnboard(pi as never, ctx as never, "/project", "provider:model")).rejects.toBe(abort);
    expect(registerArmoryTool).not.toHaveBeenCalled();
    expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("Onboarding complete"), "info");
  });

  it("skips a candidate when user rejects in editor and continues", async () => {
    const secondCandidate: CandidateRequest = { label: "Lint", command: "biome check", reasoning: "Lint code." };
    const secondDraft = { ...sampleDraft, name: "lint", command: "biome check", description: "Lint the codebase" };
    const builtLintTool = { name: "lint", command: "biome check", description: "Lint the codebase" };

    vi.mocked(mockGenerateCandidates).mockResolvedValue([sampleCandidate, secondCandidate]);
    vi.mocked(mockDraft)
      .mockResolvedValueOnce(sampleDraft) // first candidate draft
      .mockResolvedValueOnce(secondDraft); // second candidate draft
    vi.mocked(showToolEditor)
      .mockResolvedValueOnce({ rejected: true, reason: "not needed" }) // first rejected
      .mockResolvedValueOnce({ ...sampleEditorResult, name: "lint", command: "biome check" }); // second approved
    vi.mocked(buildToolFromResult).mockReturnValue(builtLintTool);

    const pi = makePi();
    // Toggle candidate 2 before candidate 1 — confirmed output must preserve original candidate order.
    const ctx = makeCtx({ selectResponses: ["Toggle 2", "Toggle 1", "Confirm"] });

    await handleOnboard(pi as never, ctx as never, "/project", "provider:model");

    expect(showToolEditor).toHaveBeenCalledTimes(2);
    expect(registerArmoryTool).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("1 registered, 1 skipped"), "info");
    // First drafted candidate must be sampleCandidate (original order), not the last-toggled one.
    expect(mockDraft).toHaveBeenNthCalledWith(
      1,
      fakeResolvedModel,
      expect.anything(),
      expect.objectContaining({ command: "npm test" }),
    );
    expect(mockDraft).toHaveBeenNthCalledWith(
      2,
      fakeResolvedModel,
      expect.anything(),
      expect.objectContaining({ command: "biome check" }),
    );
  });

  it("skips a candidate when draft is rejected by model", async () => {
    vi.mocked(mockDraft).mockResolvedValue({ rejected: true as const, reason: "Need script contents" });

    const pi = makePi();
    const ctx = makeCtx({ selectResponses: ["Toggle 1", "Confirm"] });

    await handleOnboard(pi as never, ctx as never, "/project", "provider:model");

    expect(showToolEditor).not.toHaveBeenCalled();
    expect(registerArmoryTool).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Skipped 'Run tests': draft rejected"), "info");
  });

  it("skips candidate with reserved name and notifies", async () => {
    const reservedDraft = { ...sampleDraft, name: "request_tool" };
    const reservedResult = { ...sampleEditorResult, name: "request_tool" };
    vi.mocked(mockDraft).mockResolvedValue(reservedDraft);
    vi.mocked(showToolEditor).mockResolvedValue(reservedResult);

    const pi = makePi();
    const ctx = makeCtx({ selectResponses: ["Toggle 1", "Confirm"] });

    await handleOnboard(pi as never, ctx as never, "/project", "provider:model");

    expect(registerArmoryTool).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("reserved name"), "info");
  });

  it("passes draftInput context to draftToolDefinition when candidate has context", async () => {
    const candidateWithContext: CandidateRequest = {
      label: "Build",
      command: "./scripts/build.sh",
      reasoning: "Build the project.",
      context: "#!/bin/bash\necho building",
    };
    vi.mocked(mockGenerateCandidates).mockResolvedValue([candidateWithContext]);
    vi.mocked(showToolEditor).mockResolvedValue({ rejected: true, reason: "" });

    const pi = makePi();
    const ctx = makeCtx({ selectResponses: ["Toggle 1", "Confirm"] });

    await handleOnboard(pi as never, ctx as never, "/project", "provider:model");

    expect(mockDraft).toHaveBeenCalledWith(
      fakeResolvedModel,
      expect.anything(),
      expect.objectContaining({ context: "#!/bin/bash\necho building" }),
    );
  });

  it("summary says '1 tool registered' for single successful candidate", async () => {
    const builtTool = { name: "run_tests", command: "npm test", description: "Run the test suite" };
    vi.mocked(showToolEditor).mockResolvedValue(sampleEditorResult);
    vi.mocked(buildToolFromResult).mockReturnValue(builtTool);

    const pi = makePi();
    const ctx = makeCtx({ selectResponses: ["Toggle 1", "Confirm"] });

    await handleOnboard(pi as never, ctx as never, "/project", "provider:model");

    const notifyCalls = vi.mocked(ctx.ui.notify).mock.calls;
    const summary = notifyCalls[notifyCalls.length - 1];
    expect(summary?.[0]).toContain("1 tool registered");
  });

  it("passes drafted when to the editor, registers the tool, and syncs the tool's active-state via syncToolCondition", async () => {
    const draftWithWhen = { ...sampleDraft, when: "git" as const };
    const editorResultWithWhen = { ...sampleEditorResult, when: "git" as const };
    const builtTool: ArmoryTool = {
      name: "run_tests",
      command: "npm test",
      description: "Run the test suite",
      when: "git",
    };
    vi.mocked(mockDraft).mockResolvedValue(draftWithWhen);
    vi.mocked(showToolEditor).mockResolvedValue(editorResultWithWhen);
    vi.mocked(buildToolFromResult).mockReturnValue(builtTool);

    const pi = makePi();
    const ctx = makeCtx({ selectResponses: ["Toggle 1", "Confirm"] });

    await handleOnboard(pi as never, ctx as never, "/project", "provider:model");

    expect(showToolEditor).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ when: "git" }),
      "provider:model",
      expect.anything(),
    );
    expect(registerArmoryTool).toHaveBeenCalledWith(pi, builtTool, {});
    // syncToolCondition is mocked here — assert it is invoked with the built tool rather
    // than asserting real pi active-state changes, which only the unmocked helper performs.
    expect(syncToolCondition).toHaveBeenCalledWith(pi, ctx.cwd, builtTool);
  });
});
