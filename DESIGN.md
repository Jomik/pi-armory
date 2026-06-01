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

### Flag parameters

Flags are parameters that emit a CLI flag (e.g. `--verbose`, `-m 'msg'`) when provided, and nothing when absent.

#### Syntax

- `{{--flag?}}` — optional boolean flag, outputs `--flag` when true, nothing when false/omitted
- `{{--flag}}` — required boolean flag (must be provided as true/false)
- `{{-f?}}` — short optional boolean flag, outputs `-f` when true
- `{{--flag value?}}` — optional flag+value, outputs `--flag 'value'` when provided, nothing when omitted
- `{{--flag value}}` — required flag+value, must be provided
- `{{-m message?}}` — short flag+value, outputs `-m 'message'` when provided

The rule: a placeholder starting with `-` or `--` is a flag. If a word follows the flag, it names the parameter and the flag takes a value (string). If no word follows, the parameter is boolean and named after the flag (stripped of dashes).

#### Parameter naming

- `{{--resolved?}}` → param name: `resolved`, type: boolean
- `{{-r?}}` → param name: `r`, type: boolean
- `{{--message msg?}}` → param name: `msg`, type: string
- `{{-m message?}}` → param name: `message`, type: string

#### Schema generation

- Boolean flags → `Type.Boolean()` (wrapped with `Type.Optional()` when `?` is present)
- Flag+value → `Type.String({ minLength: 1 })` (wrapped with `Type.Optional()` when `?` is present)

#### Interpolation

- Boolean flag, value `true` → emit the flag string (e.g. `--resolved`)
- Boolean flag, value `false` or omitted (when optional) → emit nothing
- Flag+value, value provided → emit `flag 'shell-escaped-value'` (space-separated)
- Flag+value, omitted (when optional) → emit nothing

#### Examples

```json
{
  "name": "jj_resolve",
  "command": "jj resolve {{--message msg?}} {{path}}",
  "description": "Mark a conflict as resolved"
}
```

With `msg="fixed merge"`, `path="src/main.ts"`: `jj resolve --message 'fixed merge' 'src/main.ts'`
With `path="src/main.ts"`, msg omitted: `jj resolve 'src/main.ts'`

```json
{
  "name": "git_log",
  "command": "git log {{--oneline?}} {{-n count?}}",
  "description": "Show git log"
}
```

With `oneline=true`, `count="10"`: `git log --oneline -n '10'`
With `oneline=false`, count omitted: `git log`

#### Non-goals

- Variadic flags (e.g. `--exclude a --exclude b`) — not supported; use variadic params and a wrapper script if needed
- Equals syntax (`--flag=value`) — output is always space-separated; bake the `=` into the command if a specific tool requires it

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

## Environment variables

Tools can declare non-secret environment variables via `env: Record<string, string>`. Keys are env var names injected into the subprocess; values are either static strings or `$VAR` references.

```json
{
  "name": "deploy",
  "command": "./deploy.sh",
  "description": "Deploy",
  "env": {
    "SERVER_URL": "https://deploy.example.com",
    "SSH_AUTH_SOCK": "$SSH_AUTH_SOCK",
    "PRICE": "$$9.99"
  }
}
```

### Value resolution

- Static string (no `$` prefix): injected verbatim
- `$NAME`: resolved from `process.env[NAME]` at execution time; throws if not set
- `$$...`: escaped literal — leading `$$` becomes `$` (use for values that start with a dollar sign)

### Visibility

**`env` values are NOT redacted from tool output.** If a resolved value appears in the subprocess's stdout/stderr, it will be visible to the LLM. Do not use `env` for credentials or tokens — use `secrets` instead.

### Interaction with secrets

When both `env` and `secrets` define the same key:
- The `env` entry is skipped entirely (no resolution, no error if `$VAR` is unset)
- The `secrets` value wins and is redacted from output

This allows a tool to declare a fallback in `env` that a user can override with a secret without breaking the config.

## Secrets

Tools can reference secrets via `secrets: Record<string, string>` where keys are environment variable names and values are macOS Keychain account identifiers (stored under service "pi-armory").

- At execution time, secrets are fetched from keychain and injected as environment variables
- Secret values are redacted from all tool output (both streamed updates and final result)
- `/armory secrets` opens a TUI panel to manage stored keychain entries (set/delete)
- If a secret is missing from keychain at execution time, the fetch throws an error

1. Agent calls `request_tool` with `{ command, reasoning, context? }`
   - `command`: the shell command or script path
   - `reasoning`: why this tool is needed, what problem it solves
   - `context`: optional file contents, script bodies, or usage examples that inform the draft
2. If a draft model is configured, it produces a full tool definition from the input
   - If the model lacks sufficient context (e.g., script contents not provided), it rejects with a reason
   - The agent receives `"Draft rejected: <reason>"` and can retry with more context
3. Tool name is auto-normalized (lowercase, underscores; e.g., "Run Tests" → `run_tests`)
4. A custom TUI form is shown (via `ctx.ui.custom`) where the human can:
   - See the proposed tool
   - Edit name, command, description inline
   - Add/remove guidelines
   - Toggle `requires_approval`
   - Choose destination: project-local (default) or global
   - Approve or reject (with optional reason)
5. On approve, the tool is written to the chosen config file and available next turn
6. On reject, the agent receives `"User rejected: <reason>"` and can adjust and retry

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

