// src/draft.ts

import type { Api, Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai";

export interface DraftInput {
  command: string;
  reasoning: string;
  context?: string;
}

export interface DraftRejection {
  rejected: true;
  reason: string;
}

export interface DraftOutput {
  name: string;
  command: string;
  description: string;
  requires_approval: boolean;
  guidelines: string[];
  destination: "project" | "global";
}

const SYSTEM_PROMPT = `You are defining a shell-command tool for a coding agent's armory.
Given a command, reasoning for why it's needed, and optional context (e.g. script contents), produce a JSON tool definition.

If you do NOT have enough information to produce a good definition — for example, the command references a script whose contents were not provided, or the reasoning is too vague to determine proper parameterization — respond with:
{"rejected": true, "reason": "<what you need>"}

Otherwise, produce a tool definition with these fields:
- name: snake_case verb phrase for the action (e.g. "run_tests", "deploy_staging"), not the binary name.
- command: the shell command. Replace values that vary between invocations with {{param_name}} placeholders. Never quote placeholders — they are auto shell-escaped. Never prefix with \`cd\` — the caller controls cwd. Prefer long flags when the short form is ambiguous or obscure.
- description: one sentence explaining what the tool does.
- requires_approval: true if destructive, mutates remote/external state, or incurs significant cost.
- guidelines: ultra-short hints (≤8 words each). Only if genuinely non-obvious; prefer [].
- destination: "global" for general-purpose tools usable in any project, "project" for repo-specific scripts/conventions.

Placeholder syntax:
- {{name}} — required single value (type "string")
- {{name?}} — optional single value (omitted from command when not provided)
- {{...name}} — required variadic (type "string[]", expands to multiple shell-escaped args)
- {{...name?}} — optional variadic (omitted when not provided)

Parameterization:
The goal is a reusable tool. Extract anything the calling agent might need or want to change between invocations. Keep hardcoded anything that defines the tool's identity and is unlikely to change.
- Do extract: identifiers, messages, branch/tag names, env names, numeric arguments (counts, limits, line numbers, ports, timeouts).
- Do NOT extract: the binary/app name, URL schemes (http/https), fixed flags that define the tool's purpose (e.g. --force in a force-push tool), or structural constants.
- Use disambiguating names when multiple similar params exist ({{target_branch}} vs {{source_branch}}). Single params can be simple ({{branch}}).
- Examples of correct parameterization:
  - tail -20 file.log → tail -{{lines}} file.log
  - grep -C 3 "error" src/ → grep -C {{context_lines}} {{pattern}} {{...paths?}}
  - curl http://localhost:3000/api → curl http://localhost:{{port}}/{{endpoint}}
  - head -n 50 → head -n {{lines}}
  - script.sh KEY field1 field2 → script.sh {{key}} {{...fields?}}

Reply with ONLY a JSON object.`;

export async function draftToolDefinition(
  model: Model<Api>,
  auth: { apiKey: string; headers?: Record<string, string> },
  input: DraftInput,
  signal?: AbortSignal,
): Promise<DraftOutput | DraftRejection> {
  let userMessage = `Command: ${input.command}\nReasoning: ${input.reasoning}`;
  if (input.context) {
    userMessage += `\n\nContext:\n${input.context}`;
  }

  // Use streamSimple and collect all text
  let text = "";
  const stream = streamSimple(
    model,
    {
      systemPrompt: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage, timestamp: Date.now() }],
    },
    { apiKey: auth.apiKey, ...(auth.headers ? { headers: auth.headers } : {}), signal },
  );

  for await (const event of stream) {
    if (event.type === "text_delta") {
      text += event.delta;
    }
  }

  // Parse JSON response
  try {
    // Strip markdown fences if model adds them despite instructions
    const cleaned = text
      .replace(/^```(?:json)?\s*\n?/m, "")
      .replace(/\n?```\s*$/m, "")
      .trim();
    const parsed = JSON.parse(cleaned) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;

      // Check if the model rejected the request
      if (obj.rejected === true) {
        return { rejected: true, reason: typeof obj.reason === "string" ? obj.reason : "" };
      }

      return {
        name: typeof obj.name === "string" ? obj.name : deriveNameFromCommand(input.command),
        command: typeof obj.command === "string" ? obj.command : input.command,
        description: typeof obj.description === "string" ? obj.description : input.command,
        requires_approval: typeof obj.requires_approval === "boolean" ? obj.requires_approval : false,
        guidelines: Array.isArray(obj.guidelines)
          ? obj.guidelines.filter((g): g is string => typeof g === "string")
          : [],
        destination: obj.destination === "global" ? "global" : "project",
      };
    }
  } catch {
    // Fall through to default
  }

  // Fallback if parsing fails
  return {
    name: deriveNameFromCommand(input.command),
    command: input.command,
    description: input.command,
    requires_approval: false,
    guidelines: [],
    destination: "project",
  };
}

export interface ReviseInput {
  current: DraftOutput;
  instruction?: string;
}

const REVISE_PROMPT = `You are improving an existing tool definition for a coding agent's armory.
Given the current definition and an optional instruction, produce an improved version.
Follow the same field rules as the original (snake_case name, no cd, etc.).

Placeholder syntax in the command field:
- {{name}} — required single value
- {{name?}} — optional single value (omitted from command when not provided)
- {{...name}} — required variadic (expands to multiple shell-escaped args)
- {{...name?}} — optional variadic (omitted when not provided)

Never quote placeholders — they are auto shell-escaped.

Parameterization:
- Do extract: identifiers, messages, branch/tag names, env names, numeric arguments (counts, limits, line numbers, ports, timeouts).
- Do NOT extract: the binary/app name, URL schemes (http/https), fixed flags that define the tool's purpose, or structural constants.
- Use disambiguating names when multiple similar params exist ({{target_branch}} vs {{source_branch}}).

Reply with ONLY a JSON object.`;

export async function reviseDraftDefinition(
  model: Model<Api>,
  auth: { apiKey: string; headers?: Record<string, string> },
  input: ReviseInput,
  signal?: AbortSignal,
): Promise<DraftOutput> {
  const currentJson = JSON.stringify(input.current, null, 2);
  const userMessage = `Current definition:\n${currentJson}${
    input.instruction ? `\n\nInstruction: ${input.instruction}` : ""
  }`;

  let text = "";
  const stream = streamSimple(
    model,
    {
      systemPrompt: REVISE_PROMPT,
      messages: [{ role: "user", content: userMessage, timestamp: Date.now() }],
    },
    { apiKey: auth.apiKey, ...(auth.headers ? { headers: auth.headers } : {}), signal },
  );

  for await (const event of stream) {
    if (event.type === "text_delta") {
      text += event.delta;
    }
  }

  try {
    const cleaned = text
      .replace(/^```(?:json)?\s*\n?/m, "")
      .replace(/\n?```\s*$/m, "")
      .trim();
    const parsed = JSON.parse(cleaned) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      return {
        name: typeof obj.name === "string" ? obj.name : input.current.name,
        command: typeof obj.command === "string" ? obj.command : input.current.command,
        description: typeof obj.description === "string" ? obj.description : input.current.description,
        requires_approval:
          typeof obj.requires_approval === "boolean" ? obj.requires_approval : input.current.requires_approval,
        guidelines: Array.isArray(obj.guidelines)
          ? obj.guidelines.filter((g): g is string => typeof g === "string")
          : input.current.guidelines,
        destination: obj.destination === "global" ? "global" : input.current.destination,
      };
    }
  } catch {
    // Fall through to fallback
  }

  // Fallback: return the current definition unchanged
  return input.current;
}

export function deriveNameFromCommand(command: string): string {
  return (
    command
      .split(/[\s|;&]+/)[0]
      .replace(/^[./]+/, "")
      .replace(/[^a-z0-9]+/gi, "_")
      .toLowerCase()
      .replace(/^[0-9_]+/, "")
      .slice(0, 30) || "tool"
  );
}
