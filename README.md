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

- `tools`: command tool definitions.
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

```json
{
  "name": "test_file",
  "command": "npm test -- {{file}}",
  "description": "Run tests for a specific file"
}
```

Values are shell-escaped before substitution. No separate `parameters` config field is needed.

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

Tools can inject environment variables into their subprocess via the `env` field:

```json
{
  "name": "deploy",
  "command": "./deploy.sh {{target}}",
  "description": "Deploy to target environment",
  "env": {
    "SERVER_URL": "https://deploy.example.com",
    "SSH_AUTH_SOCK": "$SSH_AUTH_SOCK"
  }
}
```

Values support three forms:
- **Static** - `"https://..."` passed as-is
- **Reference** - `"$VAR"` resolved from the host process environment at execution time; throws if not set
- **Escaped** - `"$$literal"` becomes `"$literal"` (use `$$` to escape a leading dollar sign)

> **⚠️ `env` values are visible in tool output shown to the LLM.** Do not put secrets here. Use the `secrets` field for sensitive values - those are stored in the macOS Keychain and redacted from all output.

Secrets and `/armory secrets` are macOS-only: storage uses the macOS Keychain (`security`) and the set/update prompt uses a local `osascript` hidden-answer dialog, which requires a GUI session (a logged-in macOS desktop session able to display dialogs). There is no cross-platform fallback; on other platforms or headless/non-GUI sessions, secrets management is unavailable.

When both `env` and `secrets` define the same key, secrets take precedence and the env entry is skipped.

#### Managing secrets

`/armory secrets` walks a native select-menu flow to manage Keychain-backed secrets:

1. An account list menu shows each configured secret account and whether it's currently found in the Keychain.
2. Selecting an account opens a status/action menu (`Set/update`, `Delete` if present, `Back`).
3. **Set/update** collects the value via a local macOS `osascript` hidden-answer dialog (a native system dialog, not a Pi dialog) - the value never traverses the Pi/Paseo UI or transcript, only the resulting save/failure notification is. However, the value is then passed to `security add-generic-password -w <value>` as a transient local process argument, so it may be visible to local process inspection (e.g. `ps`) for the brief duration of that call.
4. **Delete** requires a native confirm/cancel selection before removing the entry.

Storage (macOS Keychain, service `pi-armory`) and output redaction are unchanged by the UI used to manage entries.

### Output

Command output (stdout + stderr merged) is streamed to the agent. Non-zero exit codes are reported as tool failures with the full output included.

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
