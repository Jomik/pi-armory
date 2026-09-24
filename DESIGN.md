# pi-armory Design

Armory's interactive workflows target Pi's TUI. Tool review and editing use one TUI-native form with inline field editing, while simple choices and notifications may use Pi's standard dialog primitives. RPC client compatibility, including Paseo, is not a design goal; interactive operations fail clearly when the TUI is unavailable.

## Tool destinations

Tools have three possible destinations:

- **Session** — registered in-memory only for the current session; not saved to any config file; lost when the session ends. This is the fallback destination for newly proposed tools when no draft model is configured or the draft does not choose a destination.
- **Project** — saved to `.pi/armory.json` in the current project root; available to the current project on the next turn.
- **Global** — saved to `~/.pi/agent/armory.json`; available in all projects on the next turn.

At startup, tools are loaded from project and global config (project overrides global). Session tools are registered in-memory during the session and are accessible for editing, promotion, or deletion via `/armory edit` and `/armory delete` just like persisted tools.

### Session registry

`sessionRegistry` (a `Map<string, ArmoryTool>`) tracks all session-origin tools in `register-tool.ts`. It is populated when:
1. `request_tool` approves a tool with destination `session`.
2. `/armory edit` demotes a persisted tool to session.

The registry is never persisted. Resolution order for edit/delete is: session > project > global.

## Extension interoperability

Armory exposes project-configured tool names to other Pi extensions through the versioned `pi-armory:project-tools:v1` request event on Pi's shared event bus. The request payload contains a response callback. Armory calls it synchronously and exactly once with an array of tool names as stored in `.pi/armory.json`, sorted alphabetically; a project with no configured tools receives an empty array.

Missing, unreadable, invalid-JSON, or schema-invalid project config all yield `[]`, the same as a project with no configured tools — a consumer cannot distinguish these cases.

The result describes persisted project configuration, not the parent session's effective tool registry. A project tool remains in the result when a session-only tool shadows the same name because a new session will load the persisted project definition. Creating, moving, renaming, or deleting a project tool must be reflected in the next query, which re-reads the file fresh each time.

A consumer treats only the first callback invocation as authoritative and checks whether it was invoked before event emission returns. No synchronous response means Armory is unavailable or incompatible, and the consumer falls back to its normal behavior. Armory registers one listener per loaded extension instance; Pi removes the old subscription when reloading extensions.

The query only describes project-configured tool names. It does not grant tools, change Pi's active tools, or replace Pi's extension-level source metadata. Consumers remain responsible for authorization and user-facing grant flows. The listener must not throw; Pi contains and logs exceptions raised by consumer callbacks.

### Non-goals

- A generic per-tool metadata API in Pi core.
- Exposing global or session-only Armory tools.
- Push notifications or subscriptions for project-tool changes.
- Exposing command definitions, secrets, or other Armory configuration through the query.
- Automatically granting project tools to other sessions or agents.
- Host-specific blocked-state events or UI integrations. Armory relies on Pi's standard blocking-prompt lifecycle; hosts such as Orca and Herdr are responsible for consuming it.

## Repository-conditional tools

A tool may declare an optional built-in `when` condition. Initially, the only valid values are `git` and `jj`:

- No `when` condition means the tool is available in every workspace.
- `when: "jj"` makes the tool available only when the session workspace is a Jujutsu repository.
- `when: "git"` makes the tool available only when the session workspace is a Git repository that is not also a Jujutsu repository; Jujutsu takes precedence in colocated repositories.

Conditions are evaluated for the session workspace when a session starts, and re-applied immediately whenever a tool is created, edited, onboarded, or revealed (e.g. by deleting a shadowing tool), so its active state always matches the current workspace without waiting for the next session. A failed repository probe is treated as a non-match, not an extension failure. Unknown condition values make the configuration invalid.

The tool review form (used by `request_tool`, `/armory edit`, and onboarding) exposes the condition as an Always/Git/Jj toggle. When drafting, the draft model may infer `git` or `jj` only for commands that are genuinely specific to that backend (e.g. plumbing commands); it omits the field for tools that work equally well in both.

The condition set is intentionally closed. Arbitrary shell predicates, named condition groups, boolean expressions, and speculative operating-system or environment conditions are non-goals.

## Core Design

- Tools are shell commands with optional `{{param}}` template parameters
- Stored in `.pi/armory.json` (project) or `~/.pi/agent/armory.json` (global)
- Agent requests new tools via `request_tool` — human reviews and approves
- `requires_approval: true` prompts human yes/no before each execution
- Tools registered at session start from config
- Newly approved tools are available next turn

## Tool shape

Tools remain an array; tool names must be unique within each config file. A tool may specify an explicit `envFrom` list of named sets alongside its inline `env` bindings. No sets are injected implicitly. Tool grouping is outside this design.

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
- Interactive management, review, and approval target Pi's TUI; RPC-specific fallbacks are intentionally omitted
- Blocking status is reported through Pi's standard prompt lifecycle, not Armory events named for individual hosts
- Armory removes `bash` from the active tool set by default (`disableBash: true` in global config). Set `disableBash: false` in global config to keep `bash` active; project-local `disableBash` is ignored.

## Project onboarding (`/armory onboard`)

Onboarding is a human-initiated batch wrapper around the existing tool drafting and review flow. It requires Pi's interactive TUI mode; without a TUI it fails clearly and does not proceed. Only once a TUI is confirmed does it require either a configured `draftModel` (project or global config) or an active session model — otherwise it reports an error and does not proceed. It helps bootstrap a project by asking the draft model what common development operations an agent should have tools for, then lets the user choose which proposed requests should become actual armory tools.

The onboarding flow deliberately proposes **candidate tool requests**, not final tools. A candidate request contains a short label, a command, and reasoning/context suitable for the existing `request_tool` drafter. The user multi-selects which candidates are worth drafting through standard TUI selection dialogs (toggle individual candidates, select/clear all, then confirm). Each selected candidate is then passed through the same single-tool draft/editor/approval path used by `request_tool`, so naming, descriptions, guidelines, approval flags, destination choice, validation, saving, and registration remain centralized in the existing flow.

The user participates at two points:

1. **Candidate selection** — choose which proposed development operations should be drafted into tools.
2. **Tool review** — approve or edit each drafted tool using the existing tool editor.

The model prompt should stay task-oriented: identify common project operations an agent needs during ordinary development, such as tests, checks, formatting, lint fixes, builds, generated artifacts, or other repo-specific maintenance commands. The implementation may gather project evidence internally, but the user-facing experience should be about operations, not manifest files or scanning mechanics.

Defaults and safety policy for candidates are advisory only; final control remains with the user during multi-select and review. On approval, selected tools are saved and registered exactly like tools created through `request_tool`. Newly approved tools are still only available to the agent on the next turn.

### Non-goals

- A separate batch tool-definition editor.
- A replacement for the existing `request_tool` drafting/review pipeline.
- A background agent that repeatedly requests tools.
- Automatic continuation or tool-list refresh in the current assistant turn.

## Config merging

- Global (`~/.pi/agent/armory.json`) and project (`.pi/armory.json`) configs are additive
- Project tools override global tools with the same name
- `envSets` are scoped to their defining config: global tools may use only global sets, project tools only project sets, and session tools cannot reference `envSets`. Sets do not merge across files, even when a project tool overrides a global tool.
- Unknown or repeated names in a tool's `envFrom`, duplicate tool names within one file, and duplicate env variable keys across selected sets and inline `env` invalidate the entire defining config with a warning, consistent with existing all-or-nothing config loading; none are silently shadowed.
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

Tools can declare an `env: Record<string, EnvBinding>` map. Keys are env var names injected into the subprocess. A config may also define top-level `envSets`, a map from set names to maps of env variable names using the same binding forms. A tool opts into sets by listing their names in `envFrom`; inline `env` remains available. For example, an `atlassian` set can contain a public server name and a secret token resolver; each Jira or Confluence tool that needs them lists `atlassian` in its `envFrom`. There is no separate `secrets` field; source-object bindings can be marked secret, while literal strings are always public.

A binding is one of:

- A plain string — a **public literal**, injected verbatim (never redacted).
- `{ "env": "HOST_NAME", "secret"?: boolean }` — reads `process.env[HOST_NAME]` at execution time.
- `{ "command": "...", "secret"?: boolean }` — runs a shell command and uses its trimmed stdout as the value.

`secret: true` is only meaningful on the `env`/`command` source-object forms (literals are always public). When set, the resolved value is redacted from the main tool command's output whenever it is nonempty. Whenever any binding's resolved secret value is nonempty, streaming updates for that invocation are suppressed entirely — to prevent a secret from being disclosed across chunk boundaries — and the caller receives only the final, fully redacted success or error output.

```json
{
  "name": "deploy",
  "command": "./deploy.sh",
  "description": "Deploy",
  "env": {
    "SERVER_URL": "https://deploy.example.com",
    "GITHUB_TOKEN": { "command": "gh auth token", "secret": true },
    "API_TOKEN": {
      "command": "security find-generic-password -s pi-armory -a api-token -w",
      "secret": true
    }
  }
}
```

### Resolution

The effective bindings from selected sets and inline `env` are assembled and resolved only for an invocation, under the same redaction and resolver rules. `when` is orthogonal: inactive conditional tools do not resolve env bindings.

- Bindings are resolved once per invocation, before the main command runs, in the tool's `cwd`, using the same cancellation signal as the main command.
- `{ command }` bindings use trimmed stdout only — stderr is excluded from a successful resolution (it may still appear in error diagnostics on failure).
- Bindings are resolved independently: a resolver command does not receive values produced by other bindings, and bindings cannot reference each other.
- Resolution failures prevent the main command from running: a missing host env var, a resolver command that fails, or a resolver whose stdout is empty or all-whitespace all abort execution before the main command starts.
- Generic failure suppression only applies to a failing `{ command }` resolver marked `secret: true`: the reported error is generic (it names the binding, not the underlying command output or exit details) so resolver output and diagnostics are never leaked. A missing `{ env }` source still reports the configured host variable name, since no secret value was ever resolved. Non-secret binding failures retain full diagnostics (the resolver's error message/output) to aid debugging.

The shared tool review/edit form used by `request_tool`, `/armory edit`, and onboarding offers a multi-select **Env sets** field for `envFrom`. It lists only set names defined in the currently selected project or global destination config; session tools cannot select sets. The selector never displays or resolves binding values or resolver commands. It is available when creating or editing a tool, with an existing tool's selections preserved on opening the form and across AI re-drafts. Drafts and re-drafts cannot select or change sets; only the human can do so in the form. Inline `env` is preserved by the form but can only be hand-edited in config JSON; there is no in-form JSON editor. Set definitions are also managed in config JSON, not in the form.

Changing destination does not silently rebind a selected name to different bindings or drop selections. Selections incompatible with the destination remain in the same selector list, marked `(unresolved)`, until the user explicitly deselects them (and, if desired, selects the destination's set anew); save is refused with a clear message while any remain. This includes a same-named set whose destination definition differs in environment variable names or structurally in binding definitions, including resolver sources and `secret` flags (object key order does not matter). A move to session requires the user to clear all selected sets in the form before saving; unresolved selections block saving there too. Before writing, save validates selected names and their definitions against the current destination config and rejects duplicate env variable keys across selected sets or inline `env`. Only an explicit new selection can bind a tool to a different definition under the same name. On failed validation, neither config nor the session changes.

Env sets do not nest, refer to other sets, apply to every tool automatically, or have their own `when` conditions. Organizing tools into groups is outside scope.

Legacy `secrets` invalidates the entire config; old `$VAR`/`$$` strings are used verbatim as public literals, not expanded. Both project and global configs must be migrated manually to the binding forms above; there is no automatic migration.

### Credentials are provider-managed

Armory has no secret store and no `/armory secrets` UI. For credentials, point a `command` binding at whatever the credential's own provider or CLI offers for reading it back out — for example `gh auth token` for GitHub CLI, or `security find-generic-password -s pi-armory -a api-token -w` for a value you've stored in the macOS Keychain yourself. Users manage the underlying credential (login, rotation, revocation) through that provider or CLI; Armory only resolves and redacts the value at execution time.

1. Agent calls `request_tool` with `{ command, reasoning, context? }`
   - If the TUI is unavailable, the request is rejected before drafting or persistence
   - Only one `request_tool` call may be in flight at a time; a concurrent call is blocked with a message asking the agent to call it one at a time (enforced by the extension's `tool_call`/`tool_execution_end` handlers)
   - `command`: the shell command or script path
   - `reasoning`: why this tool is needed, what problem it solves
   - `context`: optional file contents, script bodies, or usage examples that inform the draft
2. If a draft model is configured, it produces a full tool definition from the input
   - If the model lacks sufficient context (e.g., script contents not provided), it rejects with a reason
   - The agent receives `"Draft rejected: <reason>"` and can retry with more context
3. Tool name is auto-normalized (lowercased; spaces/dashes become underscores; non `[a-z0-9_]` characters stripped; leading digits/underscores stripped so the result starts with a letter; e.g., "Run Tests" → `run_tests`). `request_tool` is a reserved name and is rejected if used. A normalized name colliding with an existing session tool or a persisted tool in the chosen destination fails as a tool execution error without overwriting it, not as a reserved-name notification
4. A single TUI-native tool form is shown where the human can:
   - Review the complete proposed definition at once
   - Navigate and edit fields inline
   - Add or remove guidelines
   - Toggle `requires_approval`
   - Choose destination: session (default), project-local, or global
   - Select Env sets by name from the chosen project/global config (none for session)
   - Request an AI re-draft without leaving the form
   - Approve or reject (with optional reason)
5. On approve, the tool is registered and available next turn
   - Session tools are stored in the in-memory session registry only
   - Project/global tools are written to the chosen config file
6. On reject, the agent receives `"User rejected: <reason>"` and can adjust and retry

## `requires_approval` execution flow

1. Agent calls a tool that has `requires_approval: true`
2. If the TUI is unavailable, the call is blocked immediately with a rejection message
3. Otherwise, an approval prompt displays the command template (not fully interpolated) alongside the structured parameters for the current values. Edit is offered only when the command has parameters
4. The review loop repeats until the human explicitly runs or rejects:
   - **Run** → command executes with the current parameters, output returned to agent
   - **Reject** → agent gets a rejection message, command does not run
   - **Edit** → `ctx.ui.editor` opens with the current parameters as pretty-printed JSON
     - Cancel returns to the review menu unchanged
     - Invalid JSON or parameters failing the tool's TypeBox schema are reported via notification, and the human can retry the editor or cancel
     - A valid edit replaces the tool call's input and returns to the review menu for another review pass; the edited command must be reviewed again before it can run

## Output handling

- stdout and stderr are merged into a single stream (same as `bash`)
- Streamed to agent via `onUpdate` with throttling
- If any active `secret: true` binding resolved to a nonempty value, `onUpdate` streaming is suppressed entirely for the invocation; only the final, fully redacted output is returned
- Non-zero exit code: throw an Error with output + exit code (agent sees it as a tool failure)
- Zero exit code: return combined output as text content (stderr included — not an error)
- No truncation limits or timeouts initially

## Editing tools (`/armory edit`)

Human-initiated flow to revise existing tools, with optional AI assistance.

### Flow

1. `/armory edit [name]` — if name omitted, show a select list of all registered tools (session, project, global)
2. Load the tool's current definition using session > project > global precedence
3. Open the same TUI-native tool-review form used by `request_tool`, pre-populated with current values, including selected Env sets
4. Human edits fields directly, or navigates to the Re-draft field and presses Enter to invoke AI re-draft
5. The edited name is normalized and validated using the same rules as `request_tool` (`normalizeName`, `VALID_NAME`, `RESERVED_NAMES`): if the result is empty, has no letter, or is a reserved name (`request_tool`), a notification explains the problem and the edit aborts before any persistence or registry mutation
6. If the destination changed, show a confirmation describing the persistence/scope consequence
7. On approve, save back to the selected destination
8. On reject, invalid/reserved name, or cancelled scope-change confirmation, no changes

### AI re-draft

Available in both `request_tool` and `/armory edit` forms:

1. User navigates to the Re-draft field (via Tab) and presses Enter → inline instruction entry mode opens in the Re-draft field
2. User types an instruction (e.g. "add an env parameter", "make it global") or leaves it blank
3. The draft model receives:
   - Current form state as a structured tool definition
   - User requirement/request/prompt from the instruction entry, if provided
   - Original `request_tool` input (`command`, `reasoning`, and optional `context`) when re-drafting a freshly requested tool
4. LLM returns an updated definition; form fields update in place
5. User can re-draft again, edit manually, or approve/reject

If the re-draft callback returns a falsy result (unavailable), a `Re-draft unavailable` notification is shown; if the callback throws, a `Re-draft failed` notification is shown. In both cases the form returns to the review menu with all fields left at their current values — no state change.

The re-draft prompt includes the current definition as structured context (not just the raw command). For `request_tool` forms it also carries forward the original request context, so the model can preserve intent and use provided script/file context while applying the latest user instruction. `/armory edit` forms do not have original request context, so they send only the current definition and instruction.

### Architecture

- One shared TUI form serves both newly requested tools and edits to existing tools
- The form presents the complete definition and owns keyboard navigation, inline field editing, validation feedback, approval, and rejection
- The form accepts an initial state from either a fresh draft or an existing tool
- Re-drafting accepts an optional inline instruction, runs asynchronously, and updates the form in place without discarding the current state on failure
- Revision requests include the full current definition, optional instruction, and optional original request context rather than only the raw command

### Draft function for revisions

New input shape alongside the existing one:

```
{ current: DraftOutput, instruction?: string, originalRequest?: DraftInput }
```

`originalRequest` is populated for re-drafts launched from the `request_tool` approval form and contains the agent's original `command`, `reasoning`, and optional `context`. It is omitted for `/armory edit` re-drafts.

The revision system prompt is detailed: it describes current definition, optional original request context, optional user requirement/request/prompt, the allowed fields, placeholder syntax, and parameterization rules. It asks the model to return only a JSON object.

### Config write-back

When editing an existing tool:
- Default destination = where the tool was loaded from (session, project, or global)
- If the user toggles destination, require confirmation before applying changes
- Before saving, validate selected Env set names against the selected destination and reject unresolved destination changes as described above; a move to session requires the user to clear any selected sets in the form. On failure, notify the user and make no changes. The write-back steps below apply only after valid selection and scope checks.
- If moving from session → project/global, write to the chosen config and remove from the session registry
- If moving from project/global → session, remove from the source config and keep the tool only in the session registry
- If moving from global → project, write to project config and remove from global config — other projects lose access to this tool
- If moving from project → global, remove from project config to avoid shadowing
- Project/global moves and renames use a create-only destination save followed by guarded source removal. If removal fails, best-effort rollback removes the newly saved destination; if rollback also fails, warn that manual reconciliation is needed. Two-file moves are not fully atomic under concurrent external writes.
- If renaming/removing a higher-precedence tool reveals a lower-precedence persisted tool with the old name, re-register the revealed tool instead of deactivating the name

## Deleting tools (`/armory delete`)

Human-initiated flow to remove existing tools.

1. `/armory delete [name]` — if name omitted, show a select list of all registered tools (session, project, global)
2. Resolve using session > project > global precedence
3. Show a confirmation describing what will be removed
4. On confirmation:
   - Session tools are removed from the in-memory registry
   - Project tools are removed from `.pi/armory.json`
   - Global tools are removed from `~/.pi/agent/armory.json`
5. The deleted tool is deactivated for the current session unless removing it reveals a lower-precedence persisted tool with the same name

## Why

- Safety without sandbox overhead
- Programmatic gates (e.g., checks must pass before push)
- Prevents agent from installing things, running destructive commands
- Clean audit trail of granted capabilities
- Agent can't thrash with exploratory bash loops

