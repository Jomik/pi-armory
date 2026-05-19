import { describe, expect, it } from "vitest";
import { normalizeName, VALID_NAME } from "../src/request-tool.js";

describe("normalizeName", () => {
  it("returns an already-valid name unchanged", () => {
    expect(normalizeName("my_tool")).toBe("my_tool");
  });

  it("lowercases uppercase letters", () => {
    expect(normalizeName("MyTool")).toBe("mytool");
  });

  it("trims leading and trailing whitespace", () => {
    expect(normalizeName("  tool  ")).toBe("tool");
  });

  it("replaces spaces with underscores", () => {
    expect(normalizeName("my tool name")).toBe("my_tool_name");
  });

  it("replaces hyphens with underscores", () => {
    expect(normalizeName("my-tool-name")).toBe("my_tool_name");
  });

  it("collapses consecutive spaces/hyphens into a single underscore", () => {
    expect(normalizeName("my  tool--name")).toBe("my_tool_name");
  });

  it("removes special characters other than letters, digits, and underscores", () => {
    expect(normalizeName("my.tool!name")).toBe("mytoolname");
  });

  it("strips leading digits", () => {
    expect(normalizeName("123tool")).toBe("tool");
  });

  it("strips leading underscores (from digit/space removal)", () => {
    expect(normalizeName("_my_tool")).toBe("my_tool");
  });

  it("strips leading digits and underscores together", () => {
    expect(normalizeName("1_my_tool")).toBe("my_tool");
  });

  it("returns empty string for a purely numeric name", () => {
    expect(normalizeName("123")).toBe("");
  });

  it("returns empty string for an empty input", () => {
    expect(normalizeName("")).toBe("");
  });

  it("returns empty string for whitespace-only input", () => {
    expect(normalizeName("   ")).toBe("");
  });

  it("returns empty string when all characters are stripped", () => {
    expect(normalizeName("!!!")).toBe("");
  });

  it("handles mixed hyphens, spaces, and uppercase", () => {
    expect(normalizeName("My Cool-Tool 2")).toBe("my_cool_tool_2");
  });
});

describe("VALID_NAME", () => {
  it("accepts a simple lowercase name", () => {
    expect(VALID_NAME.test("tool")).toBe(true);
  });

  it("accepts a name with underscores and digits", () => {
    expect(VALID_NAME.test("my_tool_2")).toBe(true);
  });

  it("rejects a name starting with a digit", () => {
    expect(VALID_NAME.test("1tool")).toBe(false);
  });

  it("rejects a name starting with an underscore", () => {
    expect(VALID_NAME.test("_tool")).toBe(false);
  });

  it("rejects names with uppercase letters", () => {
    expect(VALID_NAME.test("MyTool")).toBe(false);
  });

  it("rejects names with hyphens", () => {
    expect(VALID_NAME.test("my-tool")).toBe(false);
  });

  it("rejects names with spaces", () => {
    expect(VALID_NAME.test("my tool")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(VALID_NAME.test("")).toBe(false);
  });
});
