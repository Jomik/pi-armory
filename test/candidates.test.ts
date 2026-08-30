import { streamSimple } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { CandidateRequest } from "../src/draft.js";
import { generateCandidateRequests } from "../src/draft.js";

vi.mock("@earendil-works/pi-ai");

const mockStreamSimple = vi.mocked(streamSimple);

// biome-ignore lint/suspicious/noExplicitAny: test mock returning async generator
function makeStream(json: string): any {
  return (async function* () {
    yield { type: "text_delta" as const, delta: json };
  })();
}

// biome-ignore lint/suspicious/noExplicitAny: stub model object for tests
const fakeModel = {} as any;

describe("generateCandidateRequests", () => {
  it("returns a parsed list of candidates from valid model JSON", async () => {
    const candidates: CandidateRequest[] = [
      { label: "Run tests", command: "npm test", reasoning: "Run the test suite." },
      { label: "Type check", command: "tsc --noEmit", reasoning: "Catch type errors." },
    ];
    mockStreamSimple.mockReturnValue(makeStream(JSON.stringify(candidates)));

    const result = await generateCandidateRequests(fakeModel, { apiKey: "test" }, "evidence");
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ label: "Run tests", command: "npm test" });
    expect(result[1]).toMatchObject({ label: "Type check", command: "tsc --noEmit" });
  });

  it("includes optional context field when present in model output", async () => {
    const candidates = [
      {
        label: "Build",
        command: "./scripts/build.sh",
        reasoning: "Builds the project.",
        context: "#!/bin/bash\necho building",
      },
    ];
    mockStreamSimple.mockReturnValue(makeStream(JSON.stringify(candidates)));

    const result = await generateCandidateRequests(fakeModel, { apiKey: "test" }, "evidence");
    expect(result[0]?.context).toBe("#!/bin/bash\necho building");
  });

  it("omits context field when absent from model output", async () => {
    const candidates = [{ label: "Lint", command: "biome check", reasoning: "Lint the project." }];
    mockStreamSimple.mockReturnValue(makeStream(JSON.stringify(candidates)));

    const result = await generateCandidateRequests(fakeModel, { apiKey: "test" }, "evidence");
    expect(result[0]).not.toHaveProperty("context");
  });

  it("returns empty array when model returns []", async () => {
    mockStreamSimple.mockReturnValue(makeStream("[]"));

    const result = await generateCandidateRequests(fakeModel, { apiKey: "test" }, "evidence");
    expect(result).toEqual([]);
  });

  it("throws on malformed (non-parseable) JSON", async () => {
    mockStreamSimple.mockReturnValue(makeStream("not valid json {{{"));

    await expect(generateCandidateRequests(fakeModel, { apiKey: "test" }, "evidence")).rejects.toThrow(
      /malformed JSON/,
    );
  });

  it("throws when model returns a non-array (object)", async () => {
    mockStreamSimple.mockReturnValue(makeStream(JSON.stringify({ candidates: [] })));

    await expect(generateCandidateRequests(fakeModel, { apiKey: "test" }, "evidence")).rejects.toThrow(/non-array/);
  });

  it("strips markdown code fences before parsing", async () => {
    const candidates = [{ label: "Test", command: "npm test", reasoning: "Run tests." }];
    mockStreamSimple.mockReturnValue(makeStream(`\`\`\`json\n${JSON.stringify(candidates)}\n\`\`\``));

    const result = await generateCandidateRequests(fakeModel, { apiKey: "test" }, "evidence");
    expect(result).toHaveLength(1);
    expect(result[0]?.label).toBe("Test");
  });

  it("silently skips candidates missing required fields", async () => {
    const candidates = [
      { label: "Good", command: "npm test", reasoning: "Valid." },
      { label: "Bad", command: "npm test" }, // missing reasoning
      { command: "npm run lint", reasoning: "Lint." }, // missing label
      "not an object",
    ];
    mockStreamSimple.mockReturnValue(makeStream(JSON.stringify(candidates)));

    const result = await generateCandidateRequests(fakeModel, { apiKey: "test" }, "evidence");
    // Only the first item passes validation
    expect(result).toHaveLength(1);
    expect(result[0]?.label).toBe("Good");
  });
});
