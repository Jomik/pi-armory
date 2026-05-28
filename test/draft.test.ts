import { streamSimple } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { DraftOutput, DraftRejection, ReviseInput } from "../src/draft.js";
import { deriveNameFromCommand, draftToolDefinition, reviseDraftDefinition } from "../src/draft.js";

vi.mock("@earendil-works/pi-ai");

const mockStreamSimple = vi.mocked(streamSimple);

describe("deriveNameFromCommand", () => {
  it("extracts first word from a simple command", () => {
    expect(deriveNameFromCommand("echo hello")).toBe("echo");
  });

  it("strips leading ./ and replaces non-alphanumeric with underscores", () => {
    const result = deriveNameFromCommand("./scripts/deploy.sh");
    expect(result).toBe("scripts_deploy_sh");
  });

  it("extracts first word from npm test", () => {
    expect(deriveNameFromCommand("npm test")).toBe("npm");
  });

  it("returns 'tool' for empty string", () => {
    expect(deriveNameFromCommand("")).toBe("tool");
  });

  it("strips leading digits", () => {
    expect(deriveNameFromCommand("123start")).toBe("start");
  });

  it("truncates to 30 characters", () => {
    const long = "a".repeat(40);
    const result = deriveNameFromCommand(long);
    expect(result.length).toBeLessThanOrEqual(30);
  });
});

describe("reviseDraftDefinition", () => {
  it("is exported as a function", () => {
    expect(typeof reviseDraftDefinition).toBe("function");
  });

  it("accepts a valid ReviseInput object", () => {
    const current: DraftOutput = {
      name: "run_tests",
      command: "npm test",
      description: "Run the test suite",
      requires_approval: false,
      guidelines: [],
      destination: "project",
    };
    const input: ReviseInput = { current, instruction: "Add a --watch flag" };
    expect(input.current.name).toBe("run_tests");
    expect(input.instruction).toBe("Add a --watch flag");
  });

  it("accepts ReviseInput without an instruction", () => {
    const current: DraftOutput = {
      name: "build",
      command: "npm run build",
      description: "Build the project",
      requires_approval: false,
      guidelines: [],
      destination: "global",
    };
    const input: ReviseInput = { current };
    expect(input.instruction).toBeUndefined();
  });
});

describe("DraftRejection", () => {
  it("has the expected shape", () => {
    const rejection: DraftRejection = { rejected: true, reason: "Need script contents" };
    expect(rejection.rejected).toBe(true);
    expect(rejection.reason).toBe("Need script contents");
  });
});

describe("draftToolDefinition", () => {
  // biome-ignore lint/suspicious/noExplicitAny: test mock returning async generator
  function makeStream(json: string): any {
    return (async function* () {
      yield { type: "text_delta" as const, delta: json };
    })();
  }

  // biome-ignore lint/suspicious/noExplicitAny: stub model object for tests
  const fakeModel = {} as any;

  it("returns DraftRejection when model returns rejected:true with reason", async () => {
    mockStreamSimple.mockReturnValue(makeStream(JSON.stringify({ rejected: true, reason: "Need script contents" })));
    const result = await draftToolDefinition(
      fakeModel,
      { apiKey: "test" },
      { command: "npm test", reasoning: "run tests" },
    );
    expect(result).toEqual({ rejected: true, reason: "Need script contents" });
  });

  it("returns DraftRejection with empty reason when model returns rejected:true without reason", async () => {
    mockStreamSimple.mockReturnValue(makeStream(JSON.stringify({ rejected: true })));
    const result = await draftToolDefinition(
      fakeModel,
      { apiKey: "test" },
      { command: "npm test", reasoning: "run tests" },
    );
    expect(result).toEqual({ rejected: true, reason: "" });
  });

  it("returns DraftOutput when model returns valid tool definition JSON", async () => {
    const toolDef = {
      name: "run_tests",
      command: "npm test",
      description: "Run the test suite",
      requires_approval: false,
      guidelines: [],
      destination: "project",
    };
    mockStreamSimple.mockReturnValue(makeStream(JSON.stringify(toolDef)));
    const result = await draftToolDefinition(
      fakeModel,
      { apiKey: "test" },
      { command: "npm test", reasoning: "run tests" },
    );
    expect(result).toMatchObject({ name: "run_tests", command: "npm test" });
    expect("rejected" in result).toBe(false);
  });

  it("returns fallback DraftOutput when model returns garbage/non-JSON", async () => {
    mockStreamSimple.mockReturnValue(makeStream("not valid json at all"));
    const result = await draftToolDefinition(
      fakeModel,
      { apiKey: "test" },
      { command: "npm test", reasoning: "run tests" },
    );
    expect("rejected" in result).toBe(false);
    const output = result as DraftOutput;
    expect(output.command).toBe("npm test");
    expect(output.name).toBeTruthy();
  });
});
