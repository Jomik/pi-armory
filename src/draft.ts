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
}

const SYSTEM_PROMPT = `You are defining a shell-command tool for a coding agent's armory.

Given a command and optional usage context, produce a JSON tool definition.

Rules:
- name: lowercase with underscores, concise (e.g. "run_tests", "deploy_staging")
- command: the shell command. Use {{param_name}} placeholders for dynamic values the agent should provide at call time. If the command is already complete with no dynamic parts, leave it as-is.
- description: one sentence explaining what this tool does (shown to the agent)
- requires_approval: true if the command is destructive, has side effects, or modifies external state
- guidelines: array of short behavioral instructions for the agent (when to use, when not to, preconditions). Can be empty array.
- parameters: object mapping each {{placeholder}} name to { "description": "..." }. Describe what the agent should pass. Empty object if no placeholders.

Reply with ONLY a JSON object, no markdown fences, no explanation.`;

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
  };
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
