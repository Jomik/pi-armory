# pi-armory

Declarative command tools for [pi](https://github.com/earendil-works/pi). Structured, pre-approved commands the agent can invoke directly.

## Installation

```bash
pi install npm:pi-armory
```

Or try it without installing:

```bash
pi -e npm:pi-armory
```

## Why

- Safety without sandbox overhead
- Programmatic gates (e.g., checks must pass before push)
- Prevents the agent from installing things or running destructive commands
- Clean audit trail of granted capabilities
- Agent uses named tools instead of exploratory bash loops

## How it works

pi-armory provides a fixed set of named command tools. Each tool runs a shell command with optional `{{parameter}}` placeholders — values are shell-escaped before interpolation.

### Config

Tools are defined in `.pi/armory.json` (project-local) or `~/.pi/agent/armory.json` (global). Both are loaded; project tools override global tools with the same name.

```json
{
  "tools": [
    { "name": "run_tests", "command": "npm test", "description": "Run test suite" },
    {
      "name": "deploy_staging",
      "command": "./scripts/deploy-staging.sh",
      "description": "Deploy to staging",
      "requires_approval": true,
      "guidelines": ["Only run after tests pass"]
    }
  ]
}
```

### Parameters

Parameters are declared via template syntax in the command string:

- `{{name}}` — required string
- `{{name?}}` — optional string (omitted when not provided)
- `{{...name}}` — required variadic (expands to multiple shell-escaped args)
- `{{...name?}}` — optional variadic

```json
{
  "name": "test_file",
  "command": "npm test -- {{file}}",
  "description": "Run tests for a specific file"
}
```

Values are shell-escaped before substitution. No separate `parameters` config field is needed.

### Bootstrapping

Even with no config files, `request_tool` is always available. The agent can propose new tools and the human approves them via an interactive form:

```
Agent calls: request_tool({
  command: "./scripts/deploy.sh",
  reasoning: "Need a tool to deploy to staging after tests pass",
  context: "<contents of scripts/deploy.sh>"
})
→ Draft model produces a full tool definition (or rejects if context is insufficient)
→ Human sees a TUI form, can edit fields, add/remove guidelines, toggle approval, choose project/global
→ On approve: tool is saved to config and available next turn
→ On reject: human can provide a reason that’s returned to the agent
```

If the draft model determines it lacks sufficient context (e.g., command references a script whose contents weren’t provided), it rejects the request with a reason. The agent receives the rejection message and can retry with additional context.

Tool names are automatically normalized to lowercase with underscores (e.g., "Run Tests" → `run_tests`).

### Approval gate

Tools with `requires_approval: true` prompt the human for confirmation before each execution. The agent sees whether execution was approved or rejected.

### Output

Command output (stdout + stderr merged) is streamed to the agent. Non-zero exit codes are reported as tool failures with the full output included.

## Design

See [DESIGN.md](./DESIGN.md) for the full specification.
