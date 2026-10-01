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

Requires `@earendil-works/pi` (and the `pi-ai`, `pi-coding-agent`, `pi-tui` packages) version `0.85.1` or later. Interactive request/review/approval workflows require Pi's TUI mode and are not supported in RPC clients.

## Design

See [DESIGN.md](./DESIGN.md) for the full specification.

## Why

- Safety without sandbox overhead
- Programmatic gates (e.g., checks must pass before push)
- Prevents the agent from installing things or running destructive commands
- Clean audit trail of granted capabilities
- Agent uses named tools instead of exploratory bash loops

## How it works

pi-armory provides a fixed set of named command tools. Each tool runs a shell command with optional `{{parameter}}` placeholders - values are shell-escaped before interpolation.

Tool review and editing use a single Pi TUI custom form with inline field editing - guidelines, the approval toggle, destination, re-draft, and approve/reject all live in that one form. Simple selection and confirmation prompts (e.g. pickers, native confirm dialogs) use Pi's standard dialog primitives. Interactive request/review/approval workflows require Pi's TUI mode and are not supported in RPC clients such as Paseo.

### Config

Tools are defined in `.pi/armory.json` (project-local) or `~/.pi/agent/armory.json` (global). Both are loaded; project tools override global tools with the same name.

Top-level config fields:

- `tools`: array of command tool definitions; names must be unique within each file.
- `envSets`: optional map of set names to maps of environment variable bindings, selected by tools in the same file.
- `draftModel`: optional `"provider:modelId"` used to draft/re-draft tool definitions. Project config overrides global config.
- `disableBash`: optional global-config boolean; defaults to `true`. Set `false` in `~/.pi/agent/armory.json` to keep pi's built-in `bash` tool active. Project-local `disableBash` is ignored.

```json
{
  "draftModel": "anthropic:claude-haiku-4.5",
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

- `{{name}}` - required string
- `{{name?}}` - optional string (omitted when not provided)
- `{{...name}}` - required variadic (expands to multiple shell-escaped args)
- `{{...name?}}` - optional variadic
- `{{--verbose}}` / `{{-v}}` - required boolean flag; `{{--verbose?}}` / `{{-v?}}` - optional boolean flag. `true` emits the flag, `false` omits it; an omitted optional value also emits nothing.
- `{{--message text}}` / `{{-m text}}` - required value flag; `{{--message text?}}` / `{{-m text?}}` - optional value flag. A provided value expands to the flag, a space, and the shell-escaped value (e.g. `--message 'hello world'`); an omitted optional value emits nothing.

```json
{
  "name": "test_file",
  "command": "npm test -- {{file}}",
  "description": "Run tests for a specific file"
}
```

Values are shell-escaped before substitution. No separate `parameters` config field is needed.

### Repository conditions

Tools may declare an optional `when: "git" | "jj"` condition; omitted means the tool is always active. `when: "jj"` requires a Jujutsu workspace; `when: "git"` requires a Git workspace that isn't also a Jujutsu repository (jj takes precedence in colocated repos). A failed repository probe deactivates conditional tools rather than failing, and unknown `when` values make the config invalid.

```json
{
  "name": "jj_status",
  "command": "jj st",
  "description": "Show jj status",
  "when": "jj"
}
```

Conditions are re-evaluated when a session starts and applied immediately whenever a tool is created, edited, onboarded, or revealed. The tool review form exposes an Always/Git/Jj toggle; the draft model only infers `git`/`jj` for commands genuinely specific to that backend.

### Bootstrapping

Even with no config files, `request_tool` is always available. The agent can propose new tools and the human approves them via the single Pi TUI custom form (inline field editing, guidelines, approval toggle, destination, re-draft, approve/reject). This requires Pi's TUI mode and is not supported in RPC clients such as Paseo. Only one `request_tool` call may be in flight at a time; concurrent calls are blocked with a message telling the agent to call it one at a time.

```
Agent calls: request_tool({
  command: "./scripts/deploy.sh",
  reasoning: "Need a tool to deploy to staging after tests pass",
  context: "<contents of scripts/deploy.sh>"
})
→ Draft model produces a full tool definition (or rejects if context is insufficient)
→ Human sees the TUI custom review form, can edit fields inline, add/remove guidelines, toggle approval, choose destination
→ On approve:
    Session  - registered in-memory only, available next turn, gone when the session ends
    Project  - saved to .pi/armory.json and available next turn
    Global   - saved to ~/.pi/agent/armory.json and available in all projects next turn
→ On reject: human can provide a reason that's returned to the agent
```

When no draft model is configured, or when the draft does not choose a destination, the destination falls back to **Session**. This keeps the armory clean: tools are only persisted when you explicitly promote them.

The form's **Env sets** multi-select lists only set names for the chosen Project or Global destination, not definitions, values, or resolver commands. Only the human selects sets; re-drafting leaves selections unchanged. Session tools cannot use sets. Switching destinations keeps selections, but a missing set or a same-name set with a different definition is marked unresolved until deselected and reselected in the new destination. Approval requires resolving these selections; saving also rejects stale or missing sets and duplicate environment keys before writing.

If the draft model determines it lacks sufficient context (e.g., command references a script whose contents weren't provided), it rejects the request with a reason. The agent receives the rejection message and can retry with additional context.

Tool names are automatically normalized: lowercased, spaces/dashes collapsed to underscores, and any character that isn't a lowercase letter, digit, or underscore is stripped. The normalized name must start with a letter (leading digits/underscores are stripped). `request_tool` is a reserved name and cannot be used for a registered tool.

### Approval gate

Tools with `requires_approval: true` prompt the human for confirmation before each execution. The agent sees whether execution was approved or rejected.

The review prompt is a structured TUI approval panel showing the command template and its parameters. Actions:

- **Run** - execute the command with the displayed parameters
- **Edit** - shown only when the tool has parameters; opens the tool call's parameter JSON in pi's standard editor for direct editing
- **Reject** - decline; execution does not proceed

Edits are schema-validated; once valid, the view returns to the approval panel before you can Run. This approval flow requires Pi's TUI mode; calls made without a TUI (e.g., headless/non-interactive runs, or RPC clients such as Paseo) are blocked outright. Armory relies on Pi's standard prompt lifecycle for this blocked state. See [DESIGN.md](DESIGN.md) for implementation details.

### Environment variables

Tools can inject environment variables into their subprocess via an inline `env` map and/or named sets. Top-level `envSets` defines reusable binding maps; a tool's `envFrom` array explicitly selects sets from its own config file. Sets are never injected implicitly or inherited across project/global files, even when names match. Selected sets and inline `env` can be combined only when their environment variable keys do not overlap; repeated set names and missing sets are invalid. There is no separate `secrets` field. Each value is a binding:

- A plain string — a **public literal**, used verbatim.
- `{ "env": "HOST_NAME", "secret"?: boolean }` — reads a host environment variable.
- `{ "command": "...", "secret"?: boolean }` — runs a shell command and uses its trimmed stdout.

```json
{
  "envSets": {
    "deploy_target": {
      "SERVER_URL": "https://deploy.example.com",
      "REGION": { "env": "DEPLOY_REGION" }
    },
    "deploy_auth": {
      "GITHUB_TOKEN": { "command": "gh auth token", "secret": true }
    }
  },
  "tools": [
    {
      "name": "deploy",
      "command": "./deploy.sh {{target}}",
      "description": "Deploy to target environment",
      "envFrom": ["deploy_target", "deploy_auth"],
      "env": { "DEPLOY_MODE": "staging" }
    }
  ]
}
```

Set `secret: true` on an `env`/`command` binding (not available on literals) to redact its resolved value — whenever nonempty — from the main command's output. Whenever any binding's resolved secret value is nonempty, streaming updates are suppressed entirely for that invocation (to avoid leaking a secret split across chunk boundaries); the caller only receives the final, fully redacted success or error output.

Selected set and inline bindings resolve once per invocation, before the main command, in the tool's working directory, sharing its cancellation signal. `{ command }` bindings use trimmed stdout only (stderr is excluded on success). Each binding resolves independently — none can see values from other bindings.

If a host env var is missing, a resolver command fails, or a resolver's stdout is empty/whitespace-only, the main command does not run. Generic failure suppression for `secret: true` bindings applies specifically to a failing `{ command }` resolver: the error is reported without leaking resolver output or diagnostics. A missing `{ env }` source still reports the configured host variable name, since no secret value was ever resolved. Failures on non-secret bindings keep their full diagnostic detail.

Legacy `secrets` fields make a config file invalid; old `$VAR` and `$$` strings are now literal values, not substitution syntax. Migrate existing project and global configs manually to `env`/`envSets` bindings; there is no automatic migration. An invalid config file is ignored in full with a warning, and saves refuse to overwrite it.

> **No built-in secret store.** Armory has no secrets store and no `/armory secrets` UI. Use a `command` binding that calls your credential's own provider or CLI — e.g. `gh auth token` for the GitHub CLI, or `security find-generic-password -s pi-armory -a api-token -w` for a value you've stored yourself in the macOS Keychain. You manage the underlying credential (login, rotation, revocation) through that provider or CLI; Armory only resolves and redacts the value at execution time.

### Output

Command output (stdout + stderr merged) is streamed to the agent. Non-zero exit codes are reported as tool failures with the full output included. If any `secret: true` binding resolved to a nonempty value, streaming is suppressed for the invocation and only the final redacted output is returned.

## Extension interoperability

Other Pi extensions can query Armory's project-configured tool names via the `pi-armory:project-tools:v1` event on Pi's shared event bus:

```js
pi.events.emit("pi-armory:project-tools:v1", {
  respond(toolNames) {
    // called synchronously, at most once
  },
});
```

The request payload is `{ respond(toolNames: string[]): void }`. Armory calls `respond` synchronously and exactly once. Only the first response counts - if a consumer checks whether `respond` was already invoked by the time `emit` returns, later or duplicate calls can be ignored.

- `undefined` (no synchronous call to `respond`) means Armory is absent or an incompatible version - fall back to normal behavior.
- `[]` means Armory responded but there are no readable, valid project tools.

Names are returned as stored in `.pi/armory.json`, sorted alphabetically. Global and session-only tools are excluded; a project tool remains listed even when a session-only tool shadows the same name. The file is read fresh on every query. A missing file, unreadable file, invalid JSON, or schema-invalid config all produce `[]`, so consumers cannot distinguish those cases from a project with no configured tools.

## Managing tools

### Editing tools

`/armory edit [name]` opens the same single Pi TUI custom form used by `request_tool` for an existing tool. If no name is given, a picker lists all tools (session + project + global). You can edit any field and optionally re-draft with AI.

If you change the **Destination** field, a confirmation is shown before the change is applied:

| Change | Effect |
|---|---|
| Session → Project | Saved to `.pi/armory.json`; removed from in-memory registry |
| Session → Global | Saved to `~/.pi/agent/armory.json`; removed from in-memory registry |
| Project/Global → Session | **Removed** from the config file; only available for the rest of this session |
| Project → Global | Moved to global config; available in all projects |
| Global → Project | Saved to project config and removed from global config; other projects lose access to it |

Renaming a tool during edit uses the same normalization, validation, and reserved-name rules as `request_tool`: the name is lowercased and normalized, must contain at least one letter, and cannot be `request_tool`. If the result is invalid or reserved, a notification explains why and the edit aborts with no config or registry changes.

Cancelling the confirmation aborts the edit — no config or registry is modified.

Editing preserves existing `envFrom` selections unless you clear or change them explicitly in the form. Moving a set-backed tool to another scope requires selecting compatible sets there; to move it to Session, explicitly deselect all sets in the form. The form blocks approval until selections are resolved, and saving refuses unresolved or stale sets. Creating or moving a tool rejects same-scope or session-name collisions rather than silently overwriting another tool. The form selects existing sets only; it does not edit set definitions or group tools.

When editing, AI re-draft can be invoked from the Re-draft field. If the draft model returns nothing (unavailable), a `Re-draft unavailable` notification is shown; if re-drafting throws, a `Re-draft failed` notification is shown. Either way, the form returns to the review menu with the current state unchanged.

### Deleting tools

`/armory delete [name]` removes a tool. If no name is given, a picker is shown.

- **Session tools** — removed from the in-memory registry immediately (no config change)
- **Project tools** — removed from `.pi/armory.json`
- **Global tools** — removed from `~/.pi/agent/armory.json`

All deletions require confirmation. Deleting a tool deactivates that name for the current session unless removing a higher-precedence tool reveals a lower-precedence persisted tool with the same name.

### Onboarding

`/armory onboard` asks a draft model what common development operations this project needs tools for, then lets you pick which to draft. It requires Pi's interactive TUI mode, and only then either a configured `draftModel` (in `.pi/armory.json` or `~/.pi/agent/armory.json`) or an active session model; without a TUI it fails clearly and does not proceed, and if a TUI is present but neither a draft model nor a session model is available, onboarding reports an error and does not proceed.

1. A native select menu lists proposed candidates as a repeated toggle loop - toggle individual candidates on/off, or `Select all`/`Clear all`, then `Confirm` or `Cancel`.
2. Each selected candidate goes through the same draft/review flow as `request_tool` (TUI custom review form, edit fields, choose destination, approve/reject).
3. Approved tools are saved and registered exactly like tools created via `request_tool`, available next turn.
