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

- Commands support `{{paramName}}` template placeholders with modifiers (`{{...name?}}`); type and optionality are expressed inline and shell-escaped before interpolation
- Separate config file (not in pi settings.json), consistent with pi-imps/pi-errands/pi-inquisitor
- `checks` is just another tool in the armory (e.g. `{ "name": "checks", "command": "npm test && npm run typecheck" }`)
- APIs are stateless per-request — tools array can change between turns, no meta-tool needed
- Armory removes `bash` from the active tool set by default (`disableBash: true` in global config). Set `disableBash: false` in global config to disable.

## Config merging

- Global (`~/.pi/agent/armory.json`) and project (`.pi/armory.json`) configs are additive
- Project tools override global tools with the same name
- `draftModel` follows the same override: project value wins over global
- If no config exists, no tools are registered — but `request_tool` is always available so the agent can bootstrap

## Parameters

Parameters are declared entirely via command template syntax — no separate config field needed.

### Template syntax

- `{{name}}` — required string
- `{{name?}}` — optional string (omitted from command when not provided)
- `{{...name}}` — required variadic (`string[]`, each element becomes a separate shell-escaped arg)
- `{{...name?}}` — optional variadic (omitted when not provided)

At execution time, values are validated with TypeBox (`minLength: 1` for strings, `minItems: 1` for arrays). If you provide a value, it must have content; omit the key entirely to skip an optional param.

### Example

```json
{
  "name": "search",
  "command": "grep -C {{context}} {{pattern}} {{...paths?}}",
  "description": "Search files for a pattern"
}
```

With `context="3"`, `pattern="error"`, `paths=["src/", "lib/"]`: `grep -C '3' 'error' 'src/' 'lib/'`
With `context="3"`, `pattern="error"`, paths omitted: `grep -C '3' 'error'`

This approach prevents injection by containing every value in single quotes regardless of its content.

## Secrets

Tools can reference secrets via `secrets: Record<string, string>` where keys are environment variable names and values are macOS Keychain account identifiers (stored under service "pi-armory").

- At execution time, secrets are fetched from keychain and injected as environment variables
- Secret values are redacted from all tool output (both streamed updates and final result)
- `/armory secrets` opens a TUI panel to manage stored keychain entries (set/delete)
- If a secret is missing from keychain at execution time, the fetch throws an error

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

## Editing tools (`/armory edit`)

Human-initiated flow to revise existing tools, with optional AI assistance.

### Flow

1. `/armory edit [name]` — if name omitted, show a select list of all registered tools
2. Load the tool's current definition from config (respecting project-overrides-global)
3. Open the same TUI form used by `request_tool`, pre-populated with current values
4. Human edits fields directly, or navigates to the Re-draft field and presses Enter to invoke AI re-draft
5. On approve, save back (to whichever config file it came from, unless destination is toggled)
6. On reject, no changes

### AI re-draft

Available in both `request_tool` and `/armory edit` forms:

1. User navigates to the Re-draft field (via Tab) and presses Enter → inline instruction input appears: "Instruction (optional): ___"
2. User types instruction (e.g. "add an env parameter", "make it global") or leaves blank
3. Current form state is sent to the draft model as context, along with the instruction
4. LLM returns an updated definition; form fields update in place
5. User can re-draft again, edit manually, or approve/reject

The re-draft prompt includes the current definition as structured context (not just the raw command), so the model can make targeted improvements rather than starting from scratch.

### Architecture

- Extract the TUI form from `request-tool.ts` into a shared component (e.g. `tool-form.ts`)
- Both `request_tool` execute and `/armory edit` handler call into the same form
- The form accepts an initial state (either from a fresh draft or from an existing tool)
- The Re-draft field triggers an async re-draft; form shows a spinner while waiting, then updates
- The draft function gains a new signature variant that accepts a full current definition + instruction (not just a raw command)

### Draft function for revisions

New input shape alongside the existing one:

```
{ current: DraftOutput, instruction?: string }
```

The system prompt for revisions is minimal: "Given a tool definition and an optional instruction, produce an improved version. Reply with ONLY a JSON object." The existing field rules apply implicitly since the model sees the structure.

### Config write-back

When editing an existing tool:
- Default destination = where the tool was loaded from (project or global)
- If the user toggles destination, save to the new location
- If moving from global → project, the project version overrides (existing merge semantics)
- If moving from project → global, remove from project config to avoid shadowing

## Why

- Safety without sandbox overhead
- Programmatic gates (e.g., checks must pass before push)
- Prevents agent from installing things, running destructive commands
- Clean audit trail of granted capabilities
- Agent can't thrash with exploratory bash loops

