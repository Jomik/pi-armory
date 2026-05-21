import { describe, expect, it } from "vitest";
import { deriveNameFromCommand, parseParameters } from "../src/draft.js";

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

describe("parseParameters", () => {
  it("returns {} for null", () => {
    expect(parseParameters(null)).toEqual({});
  });

  it("returns {} for undefined", () => {
    expect(parseParameters(undefined)).toEqual({});
  });

  it("returns {} for an array", () => {
    expect(parseParameters([])).toEqual({});
  });

  it("passes through a valid parameter entry", () => {
    expect(parseParameters({ file: { description: "A file" } })).toEqual({
      file: { description: "A file" },
    });
  });

  it("falls back to key name when value is an invalid string", () => {
    expect(parseParameters({ file: "invalid" })).toEqual({
      file: { description: "file" },
    });
  });

  it("falls back to key name when description is missing", () => {
    expect(parseParameters({ file: {} })).toEqual({
      file: { description: "file" },
    });
  });
});
