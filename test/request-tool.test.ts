import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArmoryTool } from "../src/config.js";
import { extractPlaceholders, normalizeName, VALID_NAME } from "../src/request-tool.js";
import { buildToolFromResult, parsePlaceholders, syncToolCondition } from "../src/shared.js";
import type { ToolFormResult } from "../src/tool-form.js";

describe("extractPlaceholders", () => {
  it("returns empty array for a command with no placeholders", () => {
    expect(extractPlaceholders("echo hello")).toEqual([]);
  });

  it("extracts a single placeholder", () => {
    expect(extractPlaceholders("cat {{file}}")).toEqual(["file"]);
  });

  it("extracts multiple distinct placeholders", () => {
    expect(extractPlaceholders("deploy {{file}} to {{env}}")).toEqual(["file", "env"]);
  });

  it("deduplicates repeated placeholders", () => {
    expect(extractPlaceholders("cp {{file}} {{file}}")).toEqual(["file"]);
  });

  it("still extracts inner word from nested/malformed triple braces", () => {
    expect(extractPlaceholders("{{{foo}}}")).toEqual(["foo"]);
  });

  it("extracts names from variadic/optional placeholders", () => {
    expect(extractPlaceholders("run {{key}} {{...fields?}}")).toEqual(["key", "fields"]);
  });
});

describe("parsePlaceholders", () => {
  it("parses plain placeholder as required string", () => {
    expect(parsePlaceholders("echo {{name}}")).toEqual([
      { kind: "regular", name: "name", variadic: false, optional: false },
    ]);
  });

  it("parses optional placeholder", () => {
    expect(parsePlaceholders("echo {{name?}}")).toEqual([
      { kind: "regular", name: "name", variadic: false, optional: true },
    ]);
  });

  it("parses variadic placeholder", () => {
    expect(parsePlaceholders("run {{...args}}")).toEqual([
      { kind: "regular", name: "args", variadic: true, optional: false },
    ]);
  });

  it("parses variadic optional placeholder", () => {
    expect(parsePlaceholders("run {{...args?}}")).toEqual([
      { kind: "regular", name: "args", variadic: true, optional: true },
    ]);
  });

  it("parses mixed placeholders", () => {
    expect(parsePlaceholders("cmd {{key}} {{...fields?}}")).toEqual([
      { kind: "regular", name: "key", variadic: false, optional: false },
      { kind: "regular", name: "fields", variadic: true, optional: true },
    ]);
  });

  it("deduplicates by name", () => {
    expect(parsePlaceholders("cp {{file}} {{file}}")).toEqual([
      { kind: "regular", name: "file", variadic: false, optional: false },
    ]);
  });

  it("throws on conflicting modifiers for same name", () => {
    expect(() => parsePlaceholders("run {{args}} {{...args}}")).toThrow("Conflicting modifiers for placeholder: args");
  });

  it("throws on conflicting optional modifier for same name", () => {
    expect(() => parsePlaceholders("run {{name}} {{name?}}")).toThrow("Conflicting modifiers for placeholder: name");
  });

  it("allows identical duplicate modifiers", () => {
    expect(parsePlaceholders("run {{...args?}} and {{...args?}}")).toEqual([
      { kind: "regular", name: "args", variadic: true, optional: true },
    ]);
  });

  it("parses boolean flag placeholder", () => {
    expect(parsePlaceholders("cmd {{--verbose}}")).toEqual([
      { kind: "boolean-flag", name: "verbose", flag: "--verbose", optional: false },
    ]);
  });

  it("parses optional boolean flag placeholder", () => {
    expect(parsePlaceholders("cmd {{--verbose?}}")).toEqual([
      { kind: "boolean-flag", name: "verbose", flag: "--verbose", optional: true },
    ]);
  });

  it("parses short boolean flag placeholder", () => {
    expect(parsePlaceholders("cmd {{-v}}")).toEqual([{ kind: "boolean-flag", name: "v", flag: "-v", optional: false }]);
  });

  it("parses value flag placeholder", () => {
    expect(parsePlaceholders("cmd {{--message msg}}")).toEqual([
      { kind: "value-flag", name: "msg", flag: "--message", optional: false },
    ]);
  });

  it("parses optional value flag placeholder", () => {
    expect(parsePlaceholders("cmd {{--message msg?}}")).toEqual([
      { kind: "value-flag", name: "msg", flag: "--message", optional: true },
    ]);
  });

  it("parses short value flag placeholder", () => {
    expect(parsePlaceholders("cmd {{-m message}}")).toEqual([
      { kind: "value-flag", name: "message", flag: "-m", optional: false },
    ]);
  });

  it("returns flags before regulars regardless of string position", () => {
    expect(parsePlaceholders("cmd {{file}} {{--verbose}}")).toEqual([
      { kind: "boolean-flag", name: "verbose", flag: "--verbose", optional: false },
      { kind: "regular", name: "file", variadic: false, optional: false },
    ]);
  });

  it("detects conflict when regular placeholder appears before flag with same name", () => {
    expect(() => parsePlaceholders("cmd {{verbose}} {{--verbose}}")).toThrow(
      "Conflicting modifiers for placeholder: verbose",
    );
  });
});

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

describe("buildToolFromResult", () => {
  const baseResult: ToolFormResult = {
    name: "jj_status",
    command: "jj st",
    description: "Show jj status",
    guidelines: [],
    requiresApproval: false,
    destination: "session",
  };

  it("uses selected env sets over existing sets while preserving inline env and when", () => {
    const env = { INLINE: "value" };
    const tool = buildToolFromResult({ ...baseResult, envFrom: ["new"], when: "jj" }, { envFrom: ["old"], env });
    expect(tool.envFrom).toEqual(["new"]);
    expect(tool.env).toEqual(env);
    expect(tool.when).toBe("jj");
  });

  it("clears existing env sets when the result explicitly selects none", () => {
    const tool = buildToolFromResult({ ...baseResult, envFrom: [] }, { envFrom: ["old"] });
    expect(tool.envFrom).toEqual([]);
  });

  it("preserves existing env sets when the result omits envFrom", () => {
    const tool = buildToolFromResult(baseResult, { envFrom: ["old"] });
    expect(tool.envFrom).toEqual(["old"]);
  });

  it("preserves the when condition on the built tool", () => {
    const tool = buildToolFromResult({ ...baseResult, when: "jj" });
    expect(tool.when).toBe("jj");
  });

  it("omits when when absent from the result", () => {
    const tool = buildToolFromResult(baseResult);
    expect("when" in tool).toBe(false);
  });
});

describe("syncToolCondition", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "pi-armory-sync-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  function makePi(active: string[]) {
    return { getActiveTools: vi.fn(() => active), setActiveTools: vi.fn() };
  }

  it("activates only the target tool when its condition matches, leaving others untouched", async () => {
    await mkdir(path.join(tmpDir, ".git"), { recursive: true });
    const pi = makePi(["other_tool"]);
    const tool: ArmoryTool = { name: "git_only", command: "git status", description: "d", when: "git" };

    syncToolCondition(pi as never, tmpDir, tool);

    expect(pi.setActiveTools).toHaveBeenCalledWith(["other_tool", "git_only"]);
  });

  it("activates only the target tool when it is unconditional, leaving others untouched", async () => {
    const pi = makePi(["other_tool"]);
    const tool: ArmoryTool = { name: "always_tool", command: "echo hi", description: "d" };

    syncToolCondition(pi as never, tmpDir, tool);

    expect(pi.setActiveTools).toHaveBeenCalledWith(["other_tool", "always_tool"]);
  });

  it("deactivates only the target tool on mismatch, leaving others untouched", async () => {
    await mkdir(path.join(tmpDir, ".git"), { recursive: true });
    const pi = makePi(["other_tool", "jj_only"]);
    const tool: ArmoryTool = { name: "jj_only", command: "jj st", description: "d", when: "jj" };

    syncToolCondition(pi as never, tmpDir, tool);

    expect(pi.setActiveTools).toHaveBeenCalledWith(["other_tool"]);
  });

  it("does nothing when the tool is already active and matching", () => {
    const pi = makePi(["always_tool"]);
    const tool: ArmoryTool = { name: "always_tool", command: "echo hi", description: "d" };

    syncToolCondition(pi as never, tmpDir, tool);

    expect(pi.setActiveTools).not.toHaveBeenCalled();
  });
});
