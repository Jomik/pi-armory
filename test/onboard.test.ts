import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CandidateRequest } from "../src/draft.js";

// ---------------------------------------------------------------------------
// handleOnboard — command flow
// ---------------------------------------------------------------------------

vi.mock("../src/config.js", () => ({
  saveConfig: vi.fn().mockResolvedValue(undefined),
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
}));

import { saveConfig } from "../src/config.js";
import { draftToolDefinition as mockDraft, generateCandidateRequests as mockGenerateCandidates } from "../src/draft.js";
import { handleOnboard } from "../src/onboard.js";
import { registerArmoryTool, sessionRegistry } from "../src/register-tool.js";
import { buildToolFromResult, resolveModel, showToolEditor } from "../src/shared.js";

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
  opts: { customResponses?: unknown[]; modelResolved?: boolean; authOk?: boolean; sessionModel?: unknown } = {},
) {
  const { customResponses = [], modelResolved = true, authOk = true, sessionModel = undefined } = opts;
  const customQueue = [...customResponses];

  vi.mocked(resolveModel).mockReturnValue(modelResolved ? fakeResolvedModel : undefined);

  const ctx = {
    modelRegistry: {
      getApiKeyAndHeaders: vi.fn().mockResolvedValue(authOk ? { ok: true, apiKey: "test-key" } : { ok: false }),
    },
    model: sessionModel,
    ui: {
      notify: vi.fn(),
      custom: vi.fn(async () => customQueue.shift() ?? null),
    },
  };
  return ctx;
}

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
    expect(ctx.ui.custom).not.toHaveBeenCalled();
  });
});

describe("handleOnboard — multi-select", () => {
  beforeEach(() => {
    sessionRegistry.clear();
    vi.mocked(mockGenerateCandidates).mockResolvedValue([sampleCandidate]);
  });

  afterEach(() => vi.clearAllMocks());

  it("returns without registering tools when multi-select is cancelled (null)", async () => {
    const pi = makePi();
    const ctx = makeCtx({ customResponses: [null] });

    await handleOnboard(pi as never, ctx as never, "/project", "provider:model");

    expect(registerArmoryTool).not.toHaveBeenCalled();
    expect(mockDraft).not.toHaveBeenCalled();
  });

  it("notifies when no candidates are selected (empty array)", async () => {
    const pi = makePi();
    const ctx = makeCtx({ customResponses: [[]] });

    await handleOnboard(pi as never, ctx as never, "/project", "provider:model");

    expect(ctx.ui.notify).toHaveBeenCalledWith("No candidates selected.", "info");
    expect(registerArmoryTool).not.toHaveBeenCalled();
  });
});

describe("handleOnboard — per-candidate flow", () => {
  beforeEach(() => {
    sessionRegistry.clear();
    vi.mocked(mockGenerateCandidates).mockResolvedValue([sampleCandidate]);
    vi.mocked(mockDraft).mockResolvedValue(sampleDraft);
  });

  afterEach(() => vi.clearAllMocks());

  it("drafts, shows editor, and registers an approved tool", async () => {
    const builtTool = { name: "run_tests", command: "npm test", description: "Run the test suite" };
    vi.mocked(showToolEditor).mockResolvedValue(sampleEditorResult);
    vi.mocked(buildToolFromResult).mockReturnValue(builtTool);

    const pi = makePi();
    const ctx = makeCtx({ customResponses: [[sampleCandidate]] });

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
    expect(saveConfig).toHaveBeenCalledWith(builtTool, "project", "/project");
    expect(registerArmoryTool).toHaveBeenCalledWith(pi, builtTool);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("1 tool registered"), "info");
  });

  it("registers to session when destination is session — uses sessionRegistry", async () => {
    const sessionResult = { ...sampleEditorResult, destination: "session" as const };
    const builtTool = { name: "run_tests", command: "npm test", description: "Run the test suite" };
    vi.mocked(showToolEditor).mockResolvedValue(sessionResult);
    vi.mocked(buildToolFromResult).mockReturnValue(builtTool);

    const pi = makePi();
    const ctx = makeCtx({ customResponses: [[sampleCandidate]] });

    await handleOnboard(pi as never, ctx as never, "/project", "provider:model");

    expect(saveConfig).not.toHaveBeenCalled();
    expect(registerArmoryTool).toHaveBeenCalledWith(pi, builtTool);
    expect(sessionRegistry.get("run_tests")).toEqual(builtTool);
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
    const ctx = makeCtx({ customResponses: [[sampleCandidate, secondCandidate]] });

    await handleOnboard(pi as never, ctx as never, "/project", "provider:model");

    expect(showToolEditor).toHaveBeenCalledTimes(2);
    expect(registerArmoryTool).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("1 registered, 1 skipped"), "info");
  });

  it("skips a candidate when draft is rejected by model", async () => {
    vi.mocked(mockDraft).mockResolvedValue({ rejected: true as const, reason: "Need script contents" });

    const pi = makePi();
    const ctx = makeCtx({ customResponses: [[sampleCandidate]] });

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
    const ctx = makeCtx({ customResponses: [[sampleCandidate]] });

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
    const ctx = makeCtx({ customResponses: [[candidateWithContext]] });

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
    const ctx = makeCtx({ customResponses: [[sampleCandidate]] });

    await handleOnboard(pi as never, ctx as never, "/project", "provider:model");

    const notifyCalls = vi.mocked(ctx.ui.notify).mock.calls;
    const summary = notifyCalls[notifyCalls.length - 1];
    expect(summary?.[0]).toContain("1 tool registered");
  });
});
