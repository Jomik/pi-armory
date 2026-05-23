// src/draft.ts

import type { Api, Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai";

export interface DraftInput {
  command: string;
  usage?: string;
}

export interface DraftOutput {
  name: string;
  command: string;
  description: string;
  requires_approval: boolean;
  guidelines: string[];
  parameters: Record<string, { description: string }>;
  destination: "project" | "global";
}

const SYSTEM_PROMPT = `You are defining a shell-command tool for a coding agent's armory.
Given a command and optional usage context, produce a JSON tool definition.

Fields:
- name: snake_case verb phrase for the action (e.g. "run_tests", "deploy_staging"), not the binary name.
- command: the shell command. Replace values that vary between invocations with {{param_name}} placeholders. Never quote placeholders — they are auto shell-escaped. Never prefix with \`cd\` — the caller controls cwd. Prefer long flags when the short form is ambiguous or obscure.
- description: one sentence explaining what the tool does.
- requires_approval: true if destructive, mutates remote/external state, or incurs significant cost.
- guidelines: ultra-short hints (≤8 words each). Only if genuinely non-obvious; prefer [].
- parameters: { "name": { "description": "..." } } for each {{placeholder}}. {} if none.
- destination: "global" for general-purpose tools usable in any project, "project" for repo-specific scripts/conventions.

Parameterization:
- Do extract: paths, identifiers, messages, branch/tag names, env names — anything that varies per invocation.
- Do NOT extract: fixed flags or options that define the tool's purpose (e.g. --force in a force-push tool stays hardcoded).
- Use disambiguating names when multiple similar params exist ({{target_branch}} vs {{source_branch}}). Single params can be simple ({{branch}}).

Reply with ONLY a JSON object.`;

export async function draftToolDefinition(
  model: Model<Api>,
  auth: { apiKey: string; headers?: Record<string, string> },
  input: DraftInput,
  signal?: AbortSignal,
): Promise<DraftOutput> {
  const userMessage = `Command: ${input.command}${input.usage ? `\nUsage: ${input.usage}` : ""}`;

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
      return {
        name: typeof obj.name === "string" ? obj.name : deriveNameFromCommand(input.command),
        command: typeof obj.command === "string" ? obj.command : input.command,
        description: typeof obj.description === "string" ? obj.description : input.command,
        requires_approval: typeof obj.requires_approval === "boolean" ? obj.requires_approval : false,
        guidelines: Array.isArray(obj.guidelines)
          ? obj.guidelines.filter((g): g is string => typeof g === "string")
          : [],
        parameters: parseParameters(obj.parameters),
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
    parameters: {},
    destination: "project",
  };
}

export interface ReviseInput {
  current: DraftOutput;
  instruction?: string;
}

const REVISE_PROMPT = `You are improving an existing tool definition for a coding agent's armory.
Given the current definition and an optional instruction, produce an improved version.
Follow the same field rules as the original (snake_case name, {{placeholders}} for varying values, no cd, etc.).
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
        parameters: parseParameters(obj.parameters) ?? input.current.parameters,
        destination: obj.destination === "global" ? "global" : input.current.destination,
      };
    }
  } catch {
    // Fall through to fallback
  }

  // Fallback: return the current definition unchanged
  return input.current;
}

export function parseParameters(raw: unknown): Record<string, { description: string }> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result: Record<string, { description: string }> = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (
      val &&
      typeof val === "object" &&
      "description" in val &&
      typeof (val as { description: unknown }).description === "string"
    ) {
      result[key] = { description: (val as { description: string }).description };
    } else {
      result[key] = { description: key };
    }
  }
  return result;
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
