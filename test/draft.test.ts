import { describe, expect, it } from "vitest";
import type { DraftOutput, ReviseInput } from "../src/draft.js";
import { deriveNameFromCommand, reviseDraftDefinition } from "../src/draft.js";

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
