# pi-armory Design

## Core Design

- Tools are shell commands with optional `{{param}}` template parameters
- Stored in `.pi/armory.json` (project) or `~/.pi/agent/armory.json` (global)
- Agent requests new tools via `request_tool` — human reviews and approves
- `requires_approval: true` prompts human yes/no before each execution
- Tools registered at session start from config
- Newly approved tools are available next turn

## Tool shape

```json
{
  "tools": [
    { "name": "run_tests", "command": "npm test", "description": "Run test suite", "requires_approval": false },
    {
      "name": "deploy_staging",
      "command": "./scripts/deploy-staging.sh",
      "description": "Deploy to staging",
      "requires_approval": true,
      "guidelines": ["Only run after tests pass", "Ensure git status is clean"]
    }
  ]
}
```

## Key decisions

- Commands support `{{paramName}}` template placeholders; parameters are declared in the tool config and shell-escaped before interpolation
- Separate config file (not in pi settings.json), consistent with pi-imps/pi-errands/pi-inquisitor
- `checks` is just another tool in the armory (e.g. `{ "name": "checks", "command": "npm test && npm run typecheck" }`)
- APIs are stateless per-request — tools array can change between turns, no meta-tool needed
- Armory does not remove or block `bash` — that's not its responsibility. It provides structured tools; the user controls their session's tool set separately.

## Config merging

- Global (`~/.pi/agent/armory.json`) and project (`.pi/armory.json`) configs are additive
- Project tools override global tools with the same name
- If no config exists, no tools are registered — but `request_tool` is always available so the agent can bootstrap

## Parameters

Tools can declare named parameters with `parameters: Record<string, { type: "string"; description: string }>`. The command string uses `{{paramName}}` placeholders. At execution time, each placeholder is replaced with the shell-escaped value (`'value'`, with internal single quotes escaped as `'\''`). All declared parameters are required — missing parameters throw an error. This approach prevents injection by containing every value in single quotes regardless of its content.


1. Agent calls `request_tool` with a proposed `{ name, command, description, requires_approval?, guidelines? }`
2. Tool name is auto-normalized (lowercase, underscores; e.g., "Run Tests" → `run_tests`)
3. A custom TUI form is shown (via `ctx.ui.custom`) where the human can:
   - See the proposed tool
   - Edit name, command, description inline
   - Add/remove guidelines
   - Toggle `requires_approval`
   - Choose destination: project-local (default) or global
   - Approve or reject
4. On approve, the tool is written to the chosen config file and available next turn
5. On reject, the agent gets a rejection message

## `requires_approval` execution flow

1. Agent calls a tool that has `requires_approval: true`
2. A minimal confirm/reject TUI is shown displaying the command about to run
3. Human approves → command executes, output returned to agent
4. Human rejects → agent gets a rejection message, command does not run

## Output handling

- stdout and stderr are merged into a single stream (same as `bash`)
- Streamed to agent via `onUpdate` with throttling
- Non-zero exit code: throw an Error with output + exit code (agent sees it as a tool failure)
- Zero exit code: return combined output as text content (stderr included — not an error)
- No truncation limits or timeouts initially

## Why

- Safety without sandbox overhead
- Programmatic gates (e.g., checks must pass before push)
- Prevents agent from installing things, running destructive commands
- Clean audit trail of granted capabilities
- Agent can't thrash with exploratory bash loops

