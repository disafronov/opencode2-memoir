# OpenCode Memoir: V1 to V2 Migration Analysis

> **Superseded in part:** see [`minimal-memoir-integration-research.md`](./minimal-memoir-integration-research.md). Memoir `memoir_checkout` over MCP is broken in every released MCP version (0.1.3-0.2.9 and current main), so the shared HTTP runtime and MCP checkout recommendations below are not the minimal path. The minimal research report also rejects a persistent capture queue and recommends a local MCP server plus a CLI checkout workaround.

Status: analysis and implementation plan only. No production plugin code was added.
Target package: `@zimniy/opencode2-memoir`.
Source of truth for the target API: OpenCode tag `v2.4.1` (latest stable V2 at analysis time).

Evidence labels used below:

- **[Doc]** documented behavior (official docs, package README).
- **[Source]** read from the release-tagged `v2.4.1` source tree.
- **[Verified]** exercised against a real `v2.4.1` server with an isolated XDG state and a deterministic local OpenAI-compatible model.
- **[Assumption]** plausible but not yet verified; must be covered by tests before relying on it.

Reference trees used for this analysis:

- V1 plugin: `https://github.com/disafronov/opencode-memoir`, tag `v3.3.12`, commit `2fb56f7`.
- OpenCode: `https://github.com/anomalyco/opencode`, tag `v2.4.1` (`@opencode/plugin@2.4.1`).
- Memoir: `https://github.com/zhangfengcdt/memoir`, commit `7fd1b3e`; installed `memoir-mcp 0.2.9`.

---

## 0. Executive summary

The migration is feasible with public V2 plugin APIs. The V1 functionality can be preserved, but several V1 mechanisms should not be ported:

1. Capture on the next user message. V2 can capture immediately after a successful execution with `session.execution.succeeded`; the complete turn is already committed when the event arrives. This removes the one-turn lag and most of the transcript race.
2. One `memoir-mcp` process per plugin instance. V2 runs plugin setup once per **location** in a shared server process. A process-wide runtime registry should start **one** HTTP `memoir-mcp` per Memoir store and share it across locations; this keeps the store-global Memoir branch consistent and avoids multiple processes racing on the same store. Cross-process concurrency on one store remains unsupported.
3. V1's shutdown drain. V2 interrupts in-flight sessions/tools during shutdown regardless of plugin cleanup, and the CLI has a hard 10 s shutdown deadline. Pending captures must be persisted outside the process and recovered on the next boot. `opencode serve --service` has native restart continuity; plain `serve` does not.
4. V1's per-instance branch matcher with drain. A per-store serialized capture queue is simpler and stronger: one capture at a time per store, branch match/checkout before each attempt, no concurrent branch ownership.

Key V2 capabilities that make the design simpler:

- `Plugin.define({ id, setup })` with a returned cleanup function.
- Imperative registration of the agent, command, MCP server, shell hook, and session context hook.
- `ctx.event.subscribe({ types, signal })` with durable terminal events.
- Exact turn identity: the success event has a top-level `id` (`evt_...`), and the corresponding idle message ID is `msg_` plus the same suffix. This permits exact deduplication without guessing "the last completed turn".
- `ctx.session.context({ sessionID })` immediately contains the user message, the final assistant text, and the idle marker after success.
- `ctx.session.wait({ sessionID })` (experimental namespace, exposed on the plugin session domain) plus `SessionInfo.outcome` for capture-session completion.
- `ctx.storage` key/value storage for durable pending captures across restarts.

Main limitations:

- No `callTool` in the V2 MCP domain. The plugin still needs its own MCP SDK client for `memoir_status` and `memoir_checkout`.
- `session.execution.*` events are delivered to every plugin instance, not only the owning location. The plugin must filter by the session's location. This is an observed v2.4.1 behavior and a correctness-critical issue.
- `session.context` is bounded by the latest completed compaction. A mid-turn compaction can make the original user message unavailable. Capture immediately minimizes the window.
- V2's agent schema has no generation temperature field; `temperature: 0` can only be expressed as provider request body, which is provider-dependent.
- The `skill` tool is visible to an agent whose permission rules deny `*`; execution is denied, but visibility is a leak. A session context hook can remove it.
- The plugin has no access to the resolved `model`/`small_model` config at setup. V1's model fallback is replaced at capture time by `MEMOIR_AGENT_MODEL`, then the completed session's `model`, then the native default.
- `session.wait` is marked experimental. It is verified on v2.4.1; an event-correlated fallback is documented.

Recommended target lifecycle in one sentence: resolve the store, start/reuse one `memoir-mcp` per store, register a remote MCP server with `codemode: false`, register the restricted `memoir` agent and `memoir:onboard` command, listen for successful executions, snapshot the exact completed turn, persist it, and process captures serially per store with branch matching and bounded retries.

---

## 1. Existing V1 architecture and behavioral guarantees

### 1.1 Components

| File | Responsibility |
| --- | --- |
| `src/index.ts` | V1 plugin entry (`{ id, server }`); config, shell.env, chat.message, event, dispose hooks; branch matcher; MCP and agent registration. |
| `src/mcp-client.ts` | Spawns and owns one HTTP `memoir-mcp`; internal MCP SDK client; `callMemoirTool`; port allocation, reconnect, shutdown. |
| `src/capture-coordinator.ts` | Instance-wide capture queue, deduplication, branch ownership, retry, hidden-session tracking, drain. |
| `src/capture.ts` | Transcript extraction from `session.messages`, min-chars filter, dispatch helper, legacy dedup. |
| `src/subagent.ts` | `memoir` agent definition, model resolution, throwaway session creation and `promptAsync` submission. |
| `src/path.ts` | Symlink-safe path helpers; git root/common dir store derivation; slugging. |
| `src/status.ts` | `memoir_status` JSON decoder. |
| `src/debug.ts` | Always-on lifecycle log, debug stacks, daily file output, project slug prefix. |
| `src/prompts.ts` | Cached `.tmpl` loader. |
| `prompts/onboard.tmpl` | `/memoir:onboard` command text. |
| `prompts/subagent-system.tmpl` | Capture agent system prompt. |

### 1.2 V1 lifecycle

1. OpenCode loads the V1 plugin and calls the `config` hook.
2. `setProjectContext(basename(storePath))`; `MemoirRuntime.start()` spawns one `memoir-mcp --store <store> --http --host 127.0.0.1 --port <random high port>`.
3. The runtime URL is registered as a remote MCP server named `memoir` in `config.mcp` and, as a runtime workaround, on the returned hooks object.
4. The model is resolved from `MEMOIR_AGENT_MODEL`, then `config.small_model`, then `config.model`; the `memoir` agent is added to `config.agent`.
5. `/memoir:onboard` is registered from the template.
6. `shell.env` adds `MEMOIR_STORE` to shell environments.
7. `chat.message` enqueues a capture for the **previous** completed turn whenever a real user message arrives, unless the agent is `memoir`, a part is a `memoir` subtask, or all parts are synthetic.
8. `session.idle` / `session.error` of a hidden capture session complete the coordinator state and delete the session.
9. `dispose` stops new captures, drains active captures up to 10 s, clears the branch matcher, closes the internal MCP client, and terminates the child process (SIGTERM, then SIGKILL after 1 s).

### 1.3 Functional requirements versus V1 API workarounds

| Requirement | V1 implementation | Assessment for V2 |
| --- | --- | --- |
| Capture durable facts from a completed user turn | Hidden `memoir` agent session fed with a transcript | Keep; trigger and transport change. |
| Automatic capture | `chat.message` snapshots the previous turn | **Replace** with `session.execution.succeeded`; immediate capture. |
| Avoid recursive capture | Filter `memoir` agent, `memoir` subtask parts, all-synthetic messages | **Adapt**: filter capture-agent sessions and child sessions; the V1 subtask predicate is V1-specific. |
| Deduplicate turns | Last assistant message ID | **Improve**: event `id` (`evt_...`) and exact idle message ID. |
| Min-chars pre-filter | `MEMOIR_CAPTURE_MIN_CHARS` (default 16) | Keep unchanged. |
| Auto-save switch | `MEMOIR_AUTO_SAVE=0` disables | Keep unchanged. |
| Branch-specific memory | `memoir_status` then `memoir_checkout` before capture | Keep, but remove the drain race by serializing captures per store. |
| Store path / worktrees | Git top-level plus common dir, `~/.memoir/<slug>` | Keep; feed `ctx.location.directory` into the existing helpers. |
| One Memoir process avoids double spawn | One HTTP process per plugin instance registered as remote MCP | Keep the HTTP/remote pattern; **share it per store within one server process**. |
| Hidden capture session without a user-visible response | Session with no `parentID`, `promptAsync`, silent agent | Keep conceptually; V2 supports `session.create` + `session.prompt`, and metadata improves cleanup. |
| Model selection | Env, `small_model`, `model`, OpenCode default | Keep env; drop config fallbacks (no config API); carry the active session model into capture, otherwise omit it. |
| Restricted agent | Permission object, wildcard allow, checkout deny last | Port to V2 ruleset; add tool-visibility hardening. |
| Persist pending work across shutdown | In-memory drain, best effort | **Replace** with `ctx.storage` queue plus boot recovery. |
| One active instance per store | Documented limitation | Relax within one server process via a per-store runtime and lock; cross-process remains unsupported. |
| Logging and diagnostics | Daily file, `MEMOIR_DEBUG` | Keep with per-instance logger context. |
| Onboarding command | Config command template | Port to V2 command `execute`. |

Not every V1 mechanism is a requirement. In particular, the one-turn lag, the `chat.message` subtask check, the `activeCaptures`/drain protocol, and the `promptAsync` acceptance/completion race handling are consequences of the V1 API and can be removed.

### 1.4 Behavioral guarantees from V1 tests and integration smoke

V1 has 88 tests across 8 files. The guarantees that matter for migration:

- **Trigger and snapshot**: `tests/index.test.ts:133` captures the previous completed turn on the next real message; `tests/index.test.ts:228` snapshots two turns before the first dispatch is serialized; the hook returns before `promptAsync` acceptance (`tests/index.test.ts:177`).
- **Recursive capture protection**: `tests/index.test.ts:294` ignores `memoir` subtask and synthetic messages; `src/index.ts:200-204` is the actual predicate.
- **Transcript**: `tests/capture.test.ts:65` returns the last user+assistant exchange; `:79`/`:84` return null when there is no completed assistant or no preceding user; `:90` enforces min chars; `:114` tolerates malformed transcript APIs; `:183` dispatches a throwaway session and dedupes by assistant ID.
- **Min chars**: default 16; empty/invalid env falls back to 16; `<= 0` captures any non-empty transcript (`src/capture.ts:39-46`, `tests/capture.test.ts:90-100`).
- **Dedupe**: coordinator key `JSON.stringify([parent, turnId])`; terminal history bounded to 256; below-threshold turns are marked seen without dispatch (`src/capture-coordinator.ts:30-31,191-200`).
- **Retry**: at most 2 attempts; only a terminal failure of an accepted capture retries; identical snapshot; retry cancelled on branch change or shutdown (`tests/capture-coordinator.test.ts:36,70,172,199`).
- **Branch**: serialized matcher; missing/malformed `memoir_status` cannot confirm; a new store (branch `null`) is treated as empty and checkout is attempted; checkout is confirmed by re-reading status (`tests/store.test.ts:111,140,156,182,198`).
- **Agent permissions**: `*` deny, `doom_loop` allow, `memoir_*` allow, `memoir_memoir_checkout` deny last; `temperature: 0`, `steps: 8`, hidden subagent (`tests/subagent.test.ts:100`).
- **Model**: first candidate containing `/` among `MEMOIR_AGENT_MODEL`, `config.small_model`, `config.model` (the internal `summarizeModel` slot is where V1 passes the env value); bare IDs rejected (`tests/subagent.test.ts:42-90`).
- **Store path**: override, `MEMOIR_STORE`, git root, linked worktrees share the store, slug replaces `/` and `.` (`tests/store.test.ts:25-66`).
- **Shutdown**: dispose stops accepting work and drains queued/active captures (`tests/capture-coordinator.test.ts:358`).
- **Integration smoke** (`scripts/integration-smoke.mjs`): temporary git project, isolated XDG, local deterministic OpenAI-compatible model, hidden agent, connected MCP, initial branch creation, two chat messages, one memory, only the parent session left, `memoir_get` returns content, branch is `smoke-main`, exactly one forced 400 and two identical transcripts (retry), and only `memoir_*` tools are offered with checkout absent. It does not use paid inference.

### 1.5 V1 documentation drift worth knowing

The V1 `AGENTS.md` and `README.md` are not fully aligned with the code:

- `AGENTS.md` says capture templates contain `{{TOOLS_SECTION}}` and `{{TRANSCRIPT}}`; the actual `subagent-system.tmpl` has no placeholders, and `src/subagent.ts` passes the transcript as the only task text.
- `AGENTS.md` says named exports crash the loader, but `src/index.ts` exports `currentGitBranch` and `MemoirBranchMatcher` for tests.
- `tests/setup.ts` mentions a different fallback log path than `src/debug.ts`.
- `tests/index.test.ts:411` claims to check branch/recall/status but only asserts capture prompts and singleton startup.

The migration should use the code/tests as the behavioral source, not the prose.

V1 history also explains two design constraints that remain relevant: the direct `memoir-mcp` console-script launch replaced `uvx --python 3.13` because OpenCode's V1 resolver truncated the command array (commit `01d0724`), and the HTTP/remote MCP arrangement avoids a second stdio spawn of the same Memoir store. V2 should keep both decisions.

---

## 2. V1-to-V2 API mapping

All V2 references are from tag `v2.4.1`. Paths are relative to the OpenCode repository root.

| V1 integration point | V2 mechanism | Source reference | Behavioral notes |
| --- | --- | --- | --- |
| Plugin module `{ id, server }` | `Plugin.define({ id, setup })`; setup returns `Cleanup` | `packages/plugin/src/promise/plugin.ts:24-74` | Setup is called once per location; cleanup is awaited on unload/replace. |
| Plugin directory / working directory | `ctx.location.directory`, `ctx.location.project` | `packages/schema/src/location.ts:11-29` | `Location.Info` has optional `workspaceID`; project identity is opaque. |
| Plugin options | `ctx.options` | `packages/plugin/src/promise/plugin.ts:26`; `packages/schema/src/config/plugin.ts` | Entries are `string` or `{ package, options }`. Local paths must be directories (`packages/core/src/config/plugin/source.ts:155`). |
| Module-level state | Setup closure; deliberately shared via `globalThis` only for per-store registries | `packages/core/src/plugin/supervisor.ts`; `packages/core/src/instance.ts` | The module may be loaded once and shared across locations; do not put per-location state at module scope. |
| `config` hook: MCP | `ctx.mcp.transform(editor => editor.set("memoir", cfg))` | `packages/plugin/src/promise/mcp.ts`; `packages/schema/src/mcp.ts` | `RemoteConfig` supports `url`, `disabled`, `codemode`; no `callTool`. |
| `config` hook: agent | `ctx.agent.transform(editor => editor.update("memoir", a => ...))` | `packages/plugin/src/promise/agent.ts`; `packages/schema/src/agent.ts:23-35` | `update` creates `Agent.Info.default(id)` when missing. |
| `config` hook: command template | `ctx.command.transform(editor => editor.add({ name, description, execute }))` | `packages/plugin/src/promise/command.ts`; `packages/schema/src/command.ts` | `execute` receives `{ sessionID, prompt, delivery }`; send the onboarding text with `ctx.session.prompt`. |
| `shell.env` hook | `ctx.shell.hook("create.before", event => ...)` | `packages/plugin/src/promise/shell.ts`; `packages/core/src/shell.ts:986` | Applies to shell/PTY creation; mutate `event.env`. |
| `chat.message` capture trigger | `ctx.event.subscribe({ types: ["session.execution.succeeded"], signal })` | `packages/plugin/src/promise/event.ts`; `packages/schema/src/session-event.ts:248` | `succeeded` data is only `{ sessionID }`; the event envelope has `id`, `created`, `durable`, `type`, `data`. |
| `session.idle` / `session.error` | `session.wait` plus `SessionInfo.outcome`, or terminal events | `packages/plugin/src/promise/session.ts:243`; `packages/core/src/session.ts:243`; `packages/schema/src/session.ts` | `wait` is from `ExperimentalSessionApi` but exposed on `ctx.session`; verified. |
| `session.messages({ limit: 50 })` | `ctx.session.context({ sessionID })` | `packages/plugin/src/promise/session.ts:225-244`; `packages/core/src/session.ts:162`; `packages/core/src/session/history.ts:202` | Returns full stored context from the latest completed compaction boundary onward, not model-window limited. |
| `session.create` | `ctx.session.create({ title, agent, metadata })` | `packages/core/src/session.ts:135` | Returns `SessionInfo`; metadata is opaque durable JSON. |
| `promptAsync` | `ctx.session.prompt({ sessionID, text, delivery: "queue" })` | `packages/core/src/session.ts:212` | Returns the admitted user message; admission only, not completion. |
| `session.delete` | `ctx.session.remove({ sessionID })` | `packages/core/src/session.ts:145` | Terminal events for an already removed session may still be delivered. |
| Model fallback | `MEMOIR_AGENT_MODEL` -> `session.model`; otherwise omit | `packages/schema/src/agent.ts:23`; `packages/plugin/src/promise/model.ts` | No config read API. `ctx.model.default()` at setup returned the free model, not the configured model; resolve per capture instead of setting `agent.model` at setup. |
| Permission object | `Permission.Ruleset` array | `packages/schema/src/permission.ts:60-66`; `packages/core/src/permission.ts:102`; `packages/core/src/tool.ts:327,500` | `findLast` wildcard match; last matching rule wins. |
| Agent tool visibility | Tool snapshot and `whollyDisabled` | `packages/core/src/tool.ts:327,500-506` | A tool is hidden only when the last matching action rule has resource `*` and effect `deny`; the `skill` tool is a visibility exception. |
| Branch current | `ctx.vcs.get()` -> `data.branch.current` | `packages/plugin/src/promise/vcs.ts`; `packages/schema/src/vcs.ts:12-18` | Verified on a git location; handle non-git/errors as "no branch". |
| Store path | Reuse `path.ts` with `ctx.location.directory` | V1 `src/path.ts` | No V2 API needed; keep worktree behavior. |
| Pending state | `ctx.storage` | `packages/plugin/src/promise/storage.ts`; `packages/plugin/src/storage.ts` | `get`, `set`, `remove`, `scan({ prefix, after, limit })` -> `{ entries, next }`; KV is plugin-scoped and process-global. |
| Dispose / drain | Setup cleanup + persistence | `packages/plugin/src/promise/plugin.ts:66`; `packages/cli/src/shutdown-deadline.ts:5`; `packages/core/src/session/execution/restart.ts` | Shutdown interrupts active sessions; hard 10 s deadline; native resume only in managed service mode. |
| Session search / cleanup | `ctx.session.list` | `packages/client/src/promise/generated/client.ts`; verified | Returns `{ data, cursor: { previous, next } }`; returned only the current location's sessions in the probe. Assert cross-location scope; use `metadata.memoir.kind` for orphan sweep. |

### 2.1 Event shape and identity

[Source] `Session.Execution.Succeeded` is durable with data `{ sessionID }` (`packages/schema/src/session-event.ts:248`). The event envelope delivered to plugins contains `id`, `created`, `type`, `durable`, `data`; `location` is absent for execution events.

[Source] Idle messages are projected from terminal events with `SessionMessage.ID.fromEvent(event.id)` (`packages/core/src/session/message-updater.ts:158`). The resulting ID is the event ID with the `evt_` prefix replaced by `msg_`.

[Verified] A real success event had:

```
event.id  = evt_2107cbc97001aMgEWlxJ4BY1i7
idle id   = msg_2107cbc97001aMgEWlxJ4BY1i7
```

This is the foundation of exact turn deduplication.

### 2.2 What V2 does not provide

- No MCP `callTool` in the plugin MCP domain. Keep an internal `@modelcontextprotocol/sdk` client to the same HTTP server for `memoir_status`, `memoir_checkout`, and any plugin-side calls.
- No plugin access to the resolved config (`model`, `small_model`, `agent` maps) at setup. The V1 model fallback cannot be preserved as-is.
- No `session.messages` method on the plugin `SessionDomain`; `session.context` is the public transcript source.
- No location filter on `ctx.event.subscribe`; filter manually.
- No documented guarantee that setup cleanup can drain active sessions; it cannot, as verified.

Naming caveat: the plugin's internal SDK client talks directly to `memoir-mcp`, so it uses the raw Memoir tool names (`memoir_status`, `memoir_checkout`). OpenCode's MCP namespace exposes the same tools to agents as `memoir_<server>_<tool>` (for server name `memoir`: `memoir_memoir_status`, `memoir_memoir_checkout`). Agent permission rules must use the prefixed names; the internal client is not subject to agent permissions.

---

## 3. Experimental findings

### 3.1 Harness

- OpenCode `v2.4.1` Linux x64 release binary.
- Isolated `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME`; a fresh SQLite database per scenario.
- `opencode serve --hostname 127.0.0.1 --port 41999 --print-logs`, Basic auth `opencode:testpass`.
- `OPENCODE_DISABLE_PROJECT_CONFIG=1`, `OPENCODE_DISABLE_AUTOUPDATE=1`, `OPENCODE_DISABLE_MODELS_FETCH=1`.
- A local OpenAI-compatible SSE server (`exp/fake-model.mjs`, port 35005/35006) that logs model, tools, roles, and flags; it can delay capture responses and force a capture failure.
- A local plugin directory with `package.json` `exports` and a default `{ id, setup }`.
- Reproducers under `/tmp/opencode/memoir-analysis/exp/`:
  - `probe.sh`, `probe2.sh`, `probe3.sh`: plugin loading, agent/MCP/command, multi-location.
  - `probe-remote.sh`: plugin-owned HTTP `memoir-mcp` plus remote MCP registration.
  - `shutdown.sh`, `resume.sh`: SIGTERM behavior and restart.
  - `probe-eventid.sh`: event envelope, event-to-idle mapping, storage/metadata/list/VCS.

These scripts are experimental, not part of the target repository.

### 3.2 Findings

**F1. Plugin loading and setup** [Verified]
- A local plugin path must be a directory; a direct `.js` path logs `configured plugin path must be a directory` (`packages/core/src/config/plugin/source.ts:155`) and is not loaded.
- A directory with `package.json` and `exports` works; default export `{ id, setup }` is accepted.
- Setup runs once per location; `ctx.options` is `{}` for a string plugin entry.
- A throwing setup disables the whole plugin. Every setup step must be guarded.

**F2. Registration surfaces** [Verified]
- `ctx.agent.transform(editor => editor.update("memoirprobe", ...))` creates the agent when absent; `list`/`get` return `{ location, data }` wrappers.
- `ctx.mcp.transform(editor => editor.set("memoir", ...))` registers a local or remote server. `ctx.mcp.list()` immediately after the transform can be empty; the server becomes connected asynchronously.
- `ctx.command.transform(editor => editor.add(...))` works; the command executes with `{ sessionID, delivery }`.
- `ctx.session.hook("context", ...)` runs per model request and can mutate `event.tools`.
- `ctx.shell.hook("create.before", ...)` is the V2 equivalent of V1 `shell.env` [Source].

**F3. Capture timing and context** [Verified]
- `session.execution.succeeded` arrives after the settlement commit.
- At handler entry, `ctx.session.context` already contains the full user message, the final assistant text, and the idle marker with `outcome: "succeeded"`.
- Tool-call assistant messages are present with `content: [{ type: "tool", ... }]`; tool parts are not assistant text.
- A capture session created with `agent: "memoirprobe"` and no parent: `prompt()` returned in about 3 ms (admission), `wait()` returned after about 219 ms, and `context()` contained the user prompt, tool-call assistant, final text, and idle.
- A forced provider failure produced `session.execution.failed`; context contained an assistant with empty `content` and an error plus idle `outcome: "failed"`. `wait()` still resolved.
- `session.remove` removes the session; subsequent terminal events for it may still be delivered.

**F4. Exact turn identity** [Verified]
- Event envelope keys: `["id", "created", "type", "durable", "data"]`; no `location`.
- `durable = { aggregateID: sessionID, seq, version }`.
- `event.id` maps to the idle message ID by replacing `evt_` with `msg_`.
- The context message shapes are flat variants:
  - user: `{ id, type: "user", text }`
  - assistant: `{ id, type: "assistant", content: [{ type: "text", text } | { type: "tool", ... }] }`
  - idle: `{ id, type: "idle", outcome }`
- `SessionInfo` has `outcome`, `time.idle`, `location`, `metadata`, `parentID`, `agent`.

**F5. Capture agent permissions and skill visibility** [Verified]
- Permissions `[{* deny}, {doom_loop allow}, {memoir_* allow}, {memoir_memoir_checkout deny}]` produced exactly the 8 Memoir tools plus the built-in `skill` tool in the model request; checkout was absent.
- Invoking `skill` returned a tool error (execution permission denied), but visibility remained. Deleting `event.tools.skill` in a session context hook removed it from the request.
- Omitting `agent.model` made the capture session use the configured session default (`probe/fake`). `MEMOIR_AGENT_MODEL`-style `agent.model` override worked.

**F6. Multi-location event leak** [Verified]
- After a second location booted its own plugin instance, **each** instance received both locations' `session.execution.*` events.
- Both instances captured the same project2 turn, creating two capture sessions and duplicate memory writes.
- Session execution events have no `event.location`; only `session.get({ sessionID }).location.directory` identified ownership.
- **Requirement**: filter every execution event by comparing the session's `location.directory` (and `workspaceID` when present) to `ctx.location` before acting.

**F7. Shutdown and restart** [Verified]
- A cleanup that waited 15 s for a capture hung teardown. The CLI hit its 10 s deadline and exited code 1: `shutdown did not finish within 10s; exiting. Still pending: child ... memoir-mcp ...; layer plugin-supervisor releasing`.
- A 2.5 s cleanup returned, but the in-flight capture was interrupted: assistant `error: "Step interrupted"`, empty content; the capture was lost.
- An 8 s cleanup still saw the capture interrupted: assistant `error: "Step interrupted"`, tool error `"Interaction cancelled because the location shut down"`. The server exited cleanly (code 143) after about 8.54 s.
- Conclusion: plugin cleanup cannot guarantee capture completion during shutdown. It must be bounded well under 10 s, and pending work must be persisted.
- After forced shutdown, the capture session remained in SQLite with `time_suspended` set and no idle. A fresh plain `opencode serve` on the same database did **not** resume it over 10 s.
- [Source] `packages/server/src/process.ts:126` installs `SessionRestart.resumeSuspendedSessions` only when a managed-service lifecycle is provided; plain `serve`/`--standalone` does not. Managed mode resumes suspended claims with a synthetic restart message and a 10-attempt budget (`packages/core/src/session/execution/restart.ts`).

**F8. Remote MCP and one process per store** [Verified]
- A plugin can spawn `memoir-mcp --store ... --http --host 127.0.0.1 --port <free>`, wait for the TCP port, and register `{ type: "remote", url: "http://127.0.0.1:<port>/mcp", codemode: false, disabled: false }`.
- `/api/mcp` reported connected; the main build agent's model request contained 23 direct tools, including all 9 Memoir tools and `memoir_memoir_checkout`.
- `memoir-mcp` logged `CallToolRequest` and registry population, proving real tool execution through the remote server.
- This preserves V1's one-process design and lets the plugin's internal client and the agent's MCP tools share one process (one branch state).

**F9. Storage, metadata, list, VCS** [Verified]
- `ctx.storage.set/get/scan/remove` work; `scan` returns `{ entries: [{ key, value }] }`.
- `ctx.session.create({ title, metadata })` stores arbitrary JSON metadata; `session.get` returns it; `session.list` returns `{ data, cursor: { previous, next } }` and returned only the current location's sessions in the probe. Cross-location scoping must still be asserted by the integration test.
- `ctx.vcs.get()` returns `{ location, data: { provider: "git", branch: { current: "probe-main" } } }`.
- `session.remove` of the probe session succeeded.

**F10. Model default pitfall** [Verified]
- `ctx.model.default()` at setup returned the OpenCode free model (`tidepool-alpha-free` / `big-pickle`) despite the config model being `probe/fake`; at capture time it returned `probe/fake`.
- Setting `agent.model` from the setup-time default caused capture sessions to use the free model and hit provider 429.
- Setting `agent.model = { providerID, id }` works; omitting it uses the session default.

**F11. MCP flush at first prompt** [Verified]
- A session created and prompted immediately after server readiness (before the `mcp connected` log) still had all 8 Memoir tools in its model request. `SessionContext.select` flushes MCP discovery before building the request. Recovery does not need to wait for a status event.

**F12. Commands** [Verified]
- A registered command executed with `delivery: "steer"`; calling `ctx.session.prompt` inside it produced a normal assistant turn.

### 3.3 Reproducible procedures

The full harness is at `/tmp/opencode/memoir-analysis/exp`. The essential recipe:

1. Download the OpenCode `v2.4.1` release binary into a temporary directory.
2. Create a config with `plugins: ["/abs/path/to/plugin-directory"]` and a legacy `provider` entry pointing at the local fake model.
3. Start the fake model and `opencode serve` with isolated XDG directories, a fresh database, and the config path.
4. Use the HTTP API with Basic auth:
   - `POST /api/session` (body may include `location.directory`) to create a session.
   - `POST /api/session/:id/prompt` to submit a user turn.
   - `GET /api/session/:id/context` to inspect messages.
   - `GET /api/agent`, `GET /api/mcp`, `POST /api/session/:id/command`, `DELETE /api/session/:id`.
5. Read the plugin log and the fake-model request log to assert event timing, tool lists, model IDs, and retry counts.

To reproduce the critical scenarios:

```bash
bash /tmp/opencode/memoir-analysis/exp/probe-eventid.sh   # event ID mapping, storage, metadata, list, VCS
bash /tmp/opencode/memoir-analysis/exp/probe3.sh          # multi-location event leak
bash /tmp/opencode/memoir-analysis/exp/probe-remote.sh    # remote MCP, one HTTP process
bash /tmp/opencode/memoir-analysis/exp/shutdown.sh        # shutdown interruption and deadline
bash /tmp/opencode/memoir-analysis/exp/resume.sh          # plain serve does not resume suspended capture
```

### 3.4 Assumptions still requiring tests

- `ctx.session.create` with both `agent: "memoir"` and capture metadata works together (agent and metadata were verified separately).
- `ctx.session.wait` remains available and behaves the same across the pinned V2 minor range.
- `ctx.session.list` pagination with `cursor.next` works as expected for the orphan sweep.
- A plugin-owned `memoir-mcp` restart on the same port causes V2's MCP client to reconnect without re-registration.
- `ctx.vcs.get()` returns the worktree branch (not the main worktree branch) for linked worktrees.
- `session.context` behavior for a turn that spans a compaction boundary.
- Plugin reload/unload while a capture is running; expected at-least-once behavior, not tested.
- `MEMOIR_AGENT_MODEL` with provider IDs containing slashes splits correctly at the first slash.
- Title/compaction executions may appear as root sessions with hidden built-in agents; the `agent.get` hidden/subagent filter must be tested if the local harness can trigger them.

---

## 4. Proposed V2 architecture

### 4.1 Overview

```
OpenCode server process
|
+- Location A (plugin setup) --- Location B (plugin setup) --- ...
|      |                              |
|      +-------- shared per-store process registry (globalThis) --------+
|                              |
|                     MemoirRuntime (one per store)
|                     - child: memoir-mcp --store ... --http --port ...
|                     - internal MCP SDK client (status/checkout)
|                     - remote MCP URL for every location
|                              |
|                     StoreLock (one capture at a time)
|                     RecentCache / active capture sessions
|
+- per-location registrations:
|    - MCP remote "memoir" (codemode: false)
|    - hidden subagent "memoir"
|    - command "memoir:onboard"
|    - shell hook MEMOIR_STORE
|    - session context hook: restrict memoir agent tools
|    - event loop: session.execution.succeeded
|
+- per-location capture path:
     context -> exact turn -> pending KV -> serialized worker -> branch match
     -> session.create(agent memoir, metadata) -> prompt -> wait -> outcome
     -> remove session -> remove pending / bounded retry
```

### 4.2 Components

| Component | Status | Responsibility |
| --- | --- | --- |
| `src/index.ts` | Rewritten | `Plugin.define({ id: "opencode2-memoir", setup })`; resolve store, acquire runtime, register domains, start event loop, return bounded cleanup. |
| `src/path.ts` | Reused | `safeRealpath`, `slugify`, `deriveStorePath`; input is `ctx.location.directory`. |
| `src/status.ts` | Reused | `parseMemoirStatus`. |
| `src/mcp-client.ts` | Adapted | HTTP `memoir-mcp` start/stop, internal SDK client, `callMemoirTool`, port retry; logger injected. |
| `src/registry.ts` | New | Process-wide `globalThis` registry: per-store `MemoirRuntime` refcount and start promise, per-store lock, recent turn cache, active pending-key set, active capture session set. |
| `src/agent.ts` | Adapted from V1 `subagent.ts` | V2 agent definition: hidden subagent, ruleset, `steps: 8`, optional model, V1 system prompt. |
| `src/transcript.ts` | Adapted from V1 `capture.ts` | V2 message extraction, exact idle lookup via event ID, last assistant + nearest user, min-chars. |
| `src/pending.ts` | New | `ctx.storage` persistence: keys, JSON schema, TTL, cap, scan/recovery helpers. |
| `src/capture.ts` | New | Per-location event handling, snapshot, dedupe, queue, worker loop, retries, branch matching, cleanup. |
| `src/prompts.ts` | Reused | Cached template loader. |
| `src/log.ts` | Adapted from V1 `debug.ts` | Per-instance logger factory with slug, daily file, stderr, debug stacks. |
| `prompts/*.tmpl` | Reused | Onboarding and capture system prompts. |

The shared runtime and lock are the only new infrastructure. They are required by the verified multi-location behavior and the store-global branch contract; they are not speculative abstractions.

### 4.3 Setup lifecycle

All steps are individually guarded; a failure logs and disables only the affected feature. A throw from setup would disable the entire plugin [Verified].

1. Resolve `storePath`:
   - `ctx.options.store` (V1 plugin option) -> `MEMOIR_STORE` -> git common dir via `deriveStorePath(ctx.location.directory)`.
   - `safeRealpath` the input and store.
2. Create a logger with `basename(storePath)` and the location directory.
3. Acquire the shared runtime for `storePath`:
   - Start `memoir-mcp --store <store> --http --host 127.0.0.1 --port <free>`.
   - Wait for the port; bound the start (V1 retry behavior, about 5 attempts).
   - On failure, log and continue without MCP; do not throw.
4. Register the remote MCP server if the runtime is available:
   - `ctx.mcp.transform(editor => editor.set("memoir", { type: "remote", url, codemode: false, disabled: false }))`.
   - If this fails, disable capture; do not register a useless agent.
5. Register the `memoir` agent:
   - `mode: "subagent"`, `hidden: true`, name/description, `system` from `subagent-system.tmpl`.
   - `steps: 8`.
   - no agent-level `model`; resolve the capture model per session from `MEMOIR_AGENT_MODEL`, then the completed session model, otherwise omit.
   - `request.body.temperature = 0` (provider-dependent; see risks) or omit.
   - Permissions:
     ```
     { action: "*", resource: "*", effect: "deny" }
     { action: "doom_loop", resource: "*", effect: "allow" }
     { action: "memoir_*", resource: "*", effect: "allow" }
     { action: "memoir_memoir_forget", resource: "*", effect: "deny" }   # recommended hardening
     { action: "memoir_memoir_checkout", resource: "*", effect: "deny" }
     ```
     The two denies must be last. `memoir_memoir_forget` is not needed by a capture agent and is a prompt-injection target. If strict V1 parity is preferred, remove that rule.
6. Register the command:
   - `memoir:onboard`; `execute` sends `onboard.tmpl` via `ctx.session.prompt({ sessionID: input.sessionID, text, delivery: input.delivery })`.
   - Guard against duplicate `add` on reload with `editor.get(name)`.
7. Register the shell hook:
   - `ctx.shell.hook("create.before", event => { event.env.MEMOIR_STORE = storePath })`.
8. Register the session context hook:
   - If `event.agent === "memoir"`, filter `event.tools` to keys starting with `memoir_` or equal to `doom_loop`; delete everything else (notably `skill` and any `execute` wrapper).
   - Never throw from the hook.
9. Start the event loop:
   - `ctx.event.subscribe({ types: ["session.execution.succeeded"], signal })`.
   - For each event, filter, snapshot, persist, enqueue. Do not await the capture itself.
10. If auto-save is enabled and the runtime is available, schedule recovery of pending entries for this location.
11. Return cleanup:
    - Set `shuttingDown`.
    - Abort the event subscription; await the loop for at most about 1 s.
    - Release the shared runtime (refcount; last release closes the internal client and child).
    - Do not await active captures; do not delete active capture sessions. Persisted entries are the recovery mechanism.
    - Catch all cleanup errors; cleanup must be idempotent and must finish well under 10 s.

### 4.4 Per-turn capture flow

1. `session.execution.succeeded` arrives with `event.id` and `data.sessionID`.
2. `ctx.session.get({ sessionID })`:
   - On 404, ignore.
   - If `session.agent === "memoir"`, ignore (capture session).
   - If `session.agent` is set, resolve it with `ctx.agent.get({ agentID })` and ignore hidden agents or agents with `mode: "subagent"`. This excludes the built-in `title`, `compaction`, and `summary` agents, task agents, and the capture agent. If the lookup fails, log and skip the turn. If `session.agent` is absent, treat the session as user-facing (default `build`).
   - If `session.parentID` is non-null/non-undefined, ignore (task/subagent child). Deliberate change: V1 could capture child turns; see 4.8.
   - If the session location does not match `ctx.location` (directory, plus `workspaceID` when both exist), ignore. This is mandatory [Verified].
3. Read `ctx.session.context({ sessionID })`.
4. Exact turn extraction:
   - `idleID = event.id.replace(/^evt_/, "msg_")`.
   - Find that idle in the context. If absent, log and fall back to the last idle.
   - Find the previous idle; the turn is the slice after it up to the target idle.
   - Find the last assistant with non-empty text in the slice; find the nearest preceding user in the slice.
   - Format `USER\n<text>\n\nASSISTANT\n<text>`.
   - If no user, no assistant text, or no idle, skip.
5. Min-chars check (`MEMOIR_CAPTURE_MIN_CHARS`, default 16, invalid -> 16, `<= 0` non-empty only). Below threshold: remember the event ID and skip.
6. Dedupe by event ID against the process-wide recent set and pending entry existence.
7. Persist the pending entry before dispatch:
   - key: `capture:<storeHash>:<locationHash>:<eventID>`
   - value: `{ version, eventID, sessionID, location, transcript, attempts: 0, state: "queued", createdAt }`
   - If storage fails, log and still enqueue in memory (best effort, no restart durability).
8. Push onto the location queue; the worker processes it asynchronously.

The event handler performs only a context read and a KV write; it does not wait for the LLM.

### 4.5 Capture worker and state machine

One worker at a time per store (process-wide lock), but every location has its own queue.

```
queued
  -> acquire store lock
  -> re-read pending entry (may have been removed elsewhere)
  -> resolve branch: ctx.vcs.get().data.branch.current (no branch -> proceed as V1)
  -> memoir_status -> parse branch
       - malformed/missing -> attempt failed
       - null/empty store branch -> checkout with create: true
       - different -> memoir_checkout { target, create: true }, confirm status
  -> create capture session: no parentID, agent "memoir",
     metadata { memoir: { kind: "capture", eventID, parentSessionID, store: storeHash } }
  -> persist captureSessionID and attempts + 1
  -> prompt(transcript, delivery "queue")
       - prompt rejection: remove session; treat as an attempt failure
  -> wait for completion (bounded; session.wait + timeout)
  -> session.get -> outcome
  -> remove capture session (best effort)
  -> outcome succeeded: remove pending; recent.add(eventID); release lock
  -> outcome failed: retry if attempts < 2 and not shutting down
  -> outcome interrupted:
       - reason shutdown or shuttingDown: leave pending; release lock
       - other: retry if attempts < 2
  -> release lock
```

Rules:

- **At most 2 attempts** per pending capture (V1 parity). A prompt rejection, branch failure, timeout, or execution failure counts as an attempt; shutdown interruption does not.
- **One capture at a time per store**. This replaces V1's active-capture drain: a branch switch cannot occur under a running capture, and a second capture cannot move the store branch while the first is executing. It is slower under backlog but strictly safer.
- **Branch matching** uses the internal MCP client and the same status/checkout semantics as V1. No drain callback is needed.
- **On failure after the final attempt**, remove the pending entry and log the turn/session IDs. No infinite retries.
- **On shutdown**, leave the pending entry and the capture session as-is; the server will interrupt the session, and boot recovery decides whether to retry.
- **Timeout**: bound `session.wait` (e.g., 5 minutes). On timeout, remove the session, count an attempt, and leave/retry according to the policy. The bound prevents a hung worker from blocking the store lock forever.
- **Transient failure policy**: V2 retries prompt/create rejections and branch-match failures once, within the same 2-attempt budget. V1 dropped submission rejections immediately and effectively dropped deferred branch captures. This is a deliberate reliability improvement; deterministic failures still stop after 2 attempts.

### 4.6 Pending store and recovery

Pending entry:

```ts
type PendingCapture = {
  version: 1
  eventID: string          // evt_...
  sessionID: string        // parent user session
  location: { directory: string; workspaceID?: string }
  transcript: string       // already min-chars filtered
  attempts: number
  state: "queued" | "running"
  captureSessionID?: string
  createdAt: number
}
```

- Storage key prefix includes the store hash and location hash, so recovery scans only its own entries.
- TTL 24 h; lazy prune on scan. Cap 64 entries per store; prune oldest or refuse new entries with a log.
- Do not store the raw `SessionInfo`; only the transcript and identifiers.
- Recovery at setup:
  1. If auto-save is off or the runtime is unavailable, skip recovery (entries remain until TTL).
  2. Scan the location prefix, parse valid entries, prune expired/invalid/over-attempted.
  3. For each entry with `captureSessionID`:
     - If the captured session's `outcome === "succeeded"`, remove the session and the pending entry (the memory was likely stored).
     - If `failed`/`interrupted`, remove the session and re-dispatch.
     - If still running (native managed-service resume), remove it and re-dispatch (at-least-once) or wait; the simple policy is remove and re-dispatch.
  4. Enqueue the rest in `createdAt` order. The store lock serializes across locations.
- Orphan sweep:
  - `ctx.session.list({ limit, order: "desc" })` returns `{ data, cursor }`; page with `cursor.next`.
  - Remove sessions with `metadata.memoir.kind === "capture"` that are not referenced by a pending entry and not in the process-wide active set.
  - Stop paging once sessions are older than the TTL.
- At-least-once semantics: a crash after the memory write but before pending removal can duplicate a capture. Memoir is expected to merge duplicates; this is acceptable and must be documented.

### 4.7 Multi-location and concurrency model

- Plugin setup is per location; module-level state may be shared across locations. Keep per-location state in the setup closure.
- Use a `globalThis[Symbol.for("opencode2-memoir/registry/v1")]` registry for:
  - one `MemoirRuntime` per canonical store path, with refcounts;
  - one store lock per store;
  - one recent-event cache per store;
  - one active pending-key set per store;
  - one active capture session set per process.
- Every location registers the same remote MCP URL for its store. One Memoir process serves all locations of that store in the server process; the branch state is shared and consistent.
- Every capture is serialized per store, even across locations. Worktrees/subdirectories of the same repo no longer race on the store branch inside one server process.
- Event filtering by session location prevents cross-location captures (verified leak).
- **Cross-process** concurrency on one store (two OpenCode servers) remains unsupported, exactly as in V1. The process-wide lock cannot coordinate across processes.
- The plugin lock serializes its own captures, not external MCP clients. The main agent (or another client) can still call `memoir_memoir_checkout` while a capture runs. The worker reads and confirms the branch immediately before the capture; a concurrent external switch can still race. V1 had the same limitation, because the store HEAD is store-global.

### 4.8 Deliberate behavior changes

| Change | Why | Impact |
| --- | --- | --- |
| Capture immediately on success instead of the next user message | Native V2 event; complete transcript available; removes one-turn lag | Memories are written earlier; a turn reverted immediately afterward may still be stored. |
| Persist pending captures and recover on boot | V2 interrupts active sessions during shutdown; no plain-serve resume | At-least-once instead of best-effort drain; possible duplicate after a crash. |
| Retry transient submission/branch failures once | V2's durable queue makes a transient failure worth one retry; V1 dropped them | Slightly more capture attempts; bounded by the same 2-attempt budget. |
| One capture at a time per store | Removes branch races and the V1 drain/recheck protocol | Slight backlog latency; simpler correctness. |
| Capture only user-facing (non-hidden, non-subagent) root sessions | V2 emits events for internal title/compaction agents and task children; avoids noisy/duplicate memories | If V1 captured general subagent turns, that incidental behavior is dropped. |
| Drop `small_model`/`model` fallback | No plugin config read API | Use `MEMOIR_AGENT_MODEL`, then the active session model, then the native default. V1's cheap-model default is no longer implicit. |
| Deny `memoir_memoir_forget` to the capture agent (recommended) | Prompt injection could delete memory; capture only needs add/read | One fewer Memoir tool in the capture agent; no intended functionality lost. |
| Filter capture-agent tools to `memoir_*` + `doom_loop` | V2 shows `skill` despite deny-all; future tool leaks | Stronger visibility boundary; execution was already denied. |
| Capture session carries metadata and is deleted after completion | Enables crash cleanup and orphan sweep | Slightly more metadata; no user-visible response. |
| `temperature: 0` via provider body (or omitted) | V2 agent schema has no temperature field | Provider-dependent; reasoning models may reject it. |

---

## 5. Incremental implementation plan

Each phase is independently shippable and test-first. No CI/CD or publishing changes are part of this task.

### Phase 0 - Repository/package scaffolding

- Rename the package to `@zimniy/opencode2-memoir`; keep `type: module`.
- Add `peerDependencies: { "@opencode/plugin": "^2.4.1" }` (follow the bundled Figma plugin convention of declaring the runtime package as a peer; widen the range after a compatibility matrix).
- Add `@modelcontextprotocol/sdk` as a runtime dependency.
- Add TypeScript, esbuild, tsx, Biome; build to ESM with `.d.ts` and copied prompts.
- Remove template README/CHANGELOG content only after the migration doc is reviewed.
- No `src/` implementation yet beyond placeholders.

Acceptance: `npm run build`, `npm run typecheck`, `npm test` run on an empty test suite; local plugin directory loads in a V2 server and its setup logs once.

### Phase 1 - Pure modules

- Port `path.ts`, `status.ts`, `prompts.ts`; adapt `debug.ts` to a per-instance logger factory.
- Implement V2 transcript extraction in `transcript.ts` against the verified message shape and exact idle ID.
- Port min-chars/env parsing.
- Unit tests for all of the above, including V1's path/worktree tests.

Acceptance: unit tests cover user/assistant/idle, tool-only turns, no user, multiple assistants, steering, exact idle selection, fallback to last idle, compaction boundaries, min-chars edge cases.

### Phase 2 - Runtime and MCP registration

- Port `MemoirRuntime` with injected logger and start/stop semantics.
- Add the process-wide registry (`globalThis`), per-store refcount, and start retry.
- Register the remote MCP server with `codemode: false`.
- Implement `callMemoirTool`, status parsing, and branch matching without drain.
- Unit tests for port retry, concurrent acquire, refcount release, restart, close.
- Integration: main agent sees Memoir tools and can call one; the capture agent sees no checkout; the plugin's internal client can call status/checkout.

Acceptance: `/api/mcp` connected; fake model sees direct Memoir tools; `memoir-mcp` logs a tool call; killing the child and retrying recovers (test or documented gap).

### Phase 3 - Agent, command, shell, context hook

- Implement the V2 agent definition with V1 permissions plus the recommended forget deny.
- Implement `MEMOIR_AGENT_MODEL` parsing, active-session model inheritance, and omit-model behavior.
- Register `memoir:onboard` with `execute`.
- Register the shell hook and the memoir-agent tool allowlist hook.
- Unit tests for permission rule order, model parsing, prompt loading, tool filtering.
- Integration: agent hidden, model selection, command round-trip, only allowed tools, `skill`/`execute` absent for the capture agent.

Acceptance: fake model request for the capture agent contains only Memoir tools (plus `doom_loop` if it is exposed); command produces an assistant turn; `MEMOIR_STORE` is visible in a shell tool.

### Phase 4 - Immediate capture path

- Subscribe to `session.execution.succeeded`.
- Implement location/agent/parent filtering, including hidden/subagent agents.
- Implement exact snapshot and transcript extraction.
- Implement in-memory dedupe, queue, and the worker with `session.create` / `prompt` / `wait` / `get` / `remove`.
- Implement branch match/checkout under the store lock.
- Integration: a user turn produces a capture session and a stored memory; the capture session is removed; no recursive capture; two quick turns produce two distinct captures.

Acceptance: capture is enqueued immediately after success; the parent session is not blocked; the fake model sees the transcript; the capture session disappears.

### Phase 5 - Persistence and recovery

- Add pending entry storage, TTL, cap, scan.
- Persist before dispatch; update attempts/capture session; remove on success/final failure.
- Add boot recovery and orphan sweep.
- Add bounded cleanup; abort events; release runtime; do not drain.
- Integration: SIGTERM during a delayed capture; assert the server exits within 10 s, the pending entry survives, a restart re-dispatches, and the memory is stored; assert a completed capture is not re-dispatched.
- Unit tests for malformed entries, expired entries, attempt limits, shutdown leave-pending, orphan sweep filtering.

Acceptance: no 10 s deadline violation; recovery works on plain `serve`; a succeeded capture is recognized and not duplicated on recovery.

### Phase 6 - Multi-location and store sharing

- Use the shared runtime/lock/recent cache across locations.
- Verify the event location filter with two locations and the same/different stores.
- Verify worktree store sharing and branch matching.
- Integration: project2 turn is captured exactly once by project2; project1 instance does nothing; worktrees share the store and serialize captures.

Acceptance: no cross-location duplicate; one `memoir-mcp` per store in one server process; branch is correct.

### Phase 7 - Hardening and documentation

- Add kill/restart recovery test for `memoir-mcp`.
- Add compaction and interrupted-execution tests.
- Write README: install `memoir-mcp`, V2 `plugins` config, env vars, capture timing, store/worktree model, limitations, migration note from V1.
- Decide `temperature: 0` (provider body or omit) based on the supported model matrix.
- Prepare package metadata for a future publish; do not publish or change CI.

Acceptance: full unit + integration suite green; documented limitations match observed behavior.

---

## 6. Testing strategy

### 6.1 Unit tests (Node built-in test runner, tsx)

| Area | Cases |
| --- | --- |
| Path | override, `MEMOIR_STORE`, git root, linked worktree common dir, non-git fallback, symlink realpath, slug. |
| Status | valid, null branch, missing branch, malformed JSON, non-string branch. |
| Transcript | user+assistant, tool-only assistant, no user, no text, multiple assistants, steering, exact idle found/absent, previous-idle boundary, compaction message ignored, min-chars default/invalid/zero. |
| Pending store | key format, JSON round-trip, malformed value, TTL, cap, scan paging, location filter. |
| Worker | dedupe, 2-attempt retry, prompt rejection, timeout, shutdown leave-pending, success removes entry, branch-mismatch retry cancel. |
| Agent | permission order, forget/checkout deny, model parse (first slash), omit model, steps/hidden, prompt text. |
| Runtime | port retry, concurrent start sharing, refcount, restart same URL, close idempotence, start failure retry. |
| Event filter | same/different directory, same/different workspaceID, memoir agent, hidden agent, subagent agent, child session, 404 session. |
| Logger | lifecycle always, debug stacks, file/stderr destinations, per-instance slug. |
| Prompt loader | cache, missing file. |

### 6.2 Integration tests (real `v2.4.1` server)

Use the V1 integration smoke pattern adapted to V2: temporary git project(s), isolated XDG and DB, deterministic local OpenAI-compatible SSE model, no paid inference. Pin the OpenCode version and checksum.

| Scenario | Assertions |
| --- | --- |
| Boot | Plugin setup once; agent present; MCP connected; remote URL; `codemode: false`; only expected logs. |
| First capture | User turn -> success event -> capture prompt contains the exact user/assistant text; memory stored; capture session removed; parent session intact. |
| Two quick turns | Two distinct event IDs, two captures, no "last turn" mix-up; order preserved. |
| Recursion | Capture agent execution does not enqueue another capture; no capture of capture sessions; internal title/compaction sessions do not enqueue if triggered. |
| Retry | Fake model returns 500 on the first capture request; exactly two requests with identical transcript; one memory; pending removed. |
| Branch | New store checkout creates the project branch; capture stored on it; branch remains correct after a second capture. |
| Permissions | Capture model request has only Memoir tools + `doom_loop`; checkout/forget/skill/execute absent; direct tool call to checkout is denied for the capture agent. |
| Model | `MEMOIR_AGENT_MODEL=probe/fake2` makes the capture request use `fake2`; unset uses the completed session's model, then the native default. |
| Command | `memoir:onboard` executes and produces a prompt/response. |
| Multi-location | A project2 turn is captured only by project2; project1 logs no capture; exactly one pending entry. |
| Shared store | Two worktree/subdirectory locations use one `memoir-mcp` process and one store lock; captures serialize; branch matches each location. |
| Shutdown/restart | Delay a capture; SIGTERM; server exits within 10 s; pending entry present; restart; capture re-runs; memory stored; entry and orphan session removed. |
| Completed recovery | Kill/restart after a successful capture but before entry removal (fault injection); boot sees succeeded outcome and does not re-dispatch. |
| Orphan sweep | Create a metadata-marked capture session manually; boot removes it; a normal session with the same agent is not removed. |
| Min chars / auto-save | Below threshold no capture; `MEMOIR_AUTO_SAVE=0` disables capture and recovery. |
| MCP crash | Kill `memoir-mcp`; internal client restarts it on the same port; V2 MCP reconnect behavior is recorded; if V2 does not reconnect, re-register the config (documented mitigation). |
| Non-git | No branch; capture proceeds without checkout; no crash. |
| Worktree | `git worktree add`; both locations derive the same store; branch is the worktree branch. |

### 6.3 Manual/optional experiments

- Managed service mode (`--service`) native resume: verify whether a suspended capture session is resumed and whether our boot recovery duplicates it. This mode is not the default; keep it out of the mandatory suite.
- Compaction mid-turn: force a compaction during a long tool loop and record whether the user message remains in `session.context`.
- Plugin reload while a capture is running: record at-least-once behavior.

---

## 7. Known limitations, unresolved questions, risks

| Risk / limitation | Severity | Evidence | Mitigation |
| --- | --- | --- | --- |
| Execution events leak across locations | High | [Verified] | Filter with `session.get().location` before any capture; integration test. |
| Shutdown interrupts active captures; 10 s hard deadline | High | [Verified] | Persist pending entries; cleanup bounded; never drain; recovery on boot. |
| Plain `serve` does not resume suspended sessions | High | [Verified] | Do not rely on native resume; own queue. |
| `session.wait` is experimental | Medium | [Source] + [Verified] | Pin V2 minor; integration test; event-correlated fallback if it changes. |
| `session.context` is compaction-bounded | Medium | [Source] | Capture immediately; exact event turn; document mid-turn compaction edge. |
| Event `location` absent for execution events | High | [Verified] | Session lookup filter. |
| `skill` visible despite deny-all | Medium | [Verified] | Context hook allowlist; test. |
| MCP crash reconnect by V2 unverified | Medium | [Assumption] | Kill/restart test; if needed, re-register the MCP config on runtime restart. |
| Multiple locations share one Memoir process; a crash affects all | Medium | Design | Runtime restart on same port; pending queue; refcount. |
| Cross-process store concurrency unsupported | High | V1 limitation | Document; use separate stores. |
| External MCP checkout can race a capture | Medium | Design; V1 same | The plugin lock only covers plugin captures; read/confirm the branch immediately before capture; document. |
| At-least-once duplicates after crash | Medium | Design | Memoir merge; idempotency not guaranteed; document. |
| `temperature: 0` provider-specific | Low | [Source] | Omit or use request body; test model matrix. |
| No `small_model`/`model` fallback | Medium | V2 API | `MEMOIR_AGENT_MODEL`; active session model; native default. Document. |
| Child/subagent turns no longer captured | Low | Deliberate | Explain; can relax the `parentID` filter if review requires parity. |
| Pending transcripts in local KV | Low | Design | Document local DB storage; TTL/cap; no logging of content. A single very large transcript is stored as-is; add a byte guard if KV limits appear. |
| `memoir_memoir_forget` permission change | Low | Hardening | Optional; remove for strict parity. |
| MCP process orphan on hard crash | Low | V1 same | Child tracked by plugin cleanup; hard-kill orphan is a known limitation. |
| Plugin id/storage namespace stability | Medium | Design | Never change `opencode2-memoir`; pending entries are namespaced by plugin id. |
| V2 minor API drift | Medium | API | Peer range and pinned integration version; re-run the matrix on upgrades. |

Unresolved questions:

1. Does `ctx.session.create` with `agent: "memoir"` and metadata behave identically in all V2 minor versions? (Separately verified; test together.)
2. Does V2 reconnect a remote MCP client after the HTTP child restarts on the same port? (Assumption; test.)
3. Does `session.context` retain the target turn after a compaction that happens between the turn and the event handler? (Capture immediately; test manually.)
4. Does `ctx.vcs.get()` return the worktree branch in linked worktrees? (V1 git command did; test.)
5. How does plugin reload interact with an in-flight capture and the new instance's recovery? (At-least-once; test.)
6. Does `session.wait` wait for queued follow-up work or only the current execution? (Observed current execution; test with a queued prompt.)
7. Is `temperature: 0` accepted by the default model/provider in the target environment? (Provider-dependent.)

---

## Appendix A - Target configuration sketch

```jsonc
{
  "plugins": [
    "@zimniy/opencode2-memoir"
    // Local development:
    // { "package": "/abs/path/to/opencode2-memoir", "options": { "store": "/tmp/memoir-store" } }
  ]
}
```

Environment:

- `MEMOIR_STORE` - store override (also `options.store`).
- `MEMOIR_AUTO_SAVE=0` - disable automatic capture.
- `MEMOIR_CAPTURE_MIN_CHARS` - min transcript chars (default 16; `0` = any non-empty).
- `MEMOIR_AGENT_MODEL` - `provider/model[:variant]` capture override; otherwise the completed session model applies.
- `MEMOIR_LOG` - unset = `$XDG_DATA_HOME/opencode/log/memoir/YYYY-MM-DD.log`; `stderr`; or a path.
- `MEMOIR_DEBUG=1` - verbose errors/stacks.

Requirements: `memoir-mcp` on `PATH` (`uv tool install --python 3.13 "memoir-ai[mcp]"`). The plugin intentionally launches the console script directly, as V1 did, to avoid command-array truncation.

## Appendix B - Release-tagged source references

Plugin API (`v2.4.1`):

- `packages/plugin/src/promise/plugin.ts:24-74` - `Context`, `Cleanup`, `Plugin.define`.
- `packages/plugin/src/README.md` - lifecycle, transforms, runtime hooks, cleanup.
- `packages/plugin/src/promise/session.ts:225-244` - session domain, `wait`, hooks.
- `packages/plugin/src/promise/agent.ts` - agent editor/domain.
- `packages/plugin/src/promise/command.ts` - command definition/editor.
- `packages/plugin/src/promise/mcp.ts` - MCP editor/domain, no `callTool`.
- `packages/plugin/src/promise/shell.ts` - `create.before`.
- `packages/plugin/src/promise/storage.ts` - `get/set/remove/scan`.
- `packages/plugin/src/promise/event.ts` - `subscribe`.
- `packages/plugin/src/promise/vcs.ts` - VCS domain.
- `packages/plugin/src/promise/model.ts` - model default/list.

Schema (`v2.4.1`):

- `packages/schema/src/agent.ts:23-53` - agent fields and defaults.
- `packages/schema/src/command.ts` - command info.
- `packages/schema/src/permission.ts:60-66` - rule/ruleset.
- `packages/schema/src/mcp.ts:34,63` - `codemode`, local/remote config.
- `packages/schema/src/session-event.ts:248` - execution succeeded.
- `packages/schema/src/session-message.ts` - user/assistant/idle/compaction variants.
- `packages/schema/src/session.ts` - `SessionInfo`, `outcome`, metadata.
- `packages/schema/src/config/plugin.ts` - plugin entries.

Core/server (`v2.4.1`):

- `packages/core/src/session.ts:135,145,162,212,243` - create/remove/context/prompt/wait.
- `packages/core/src/session/execution.ts:170,211` - terminal publication after settlement.
- `packages/core/src/session/message-updater.ts:158` - idle ID from event ID.
- `packages/core/src/session/history.ts:202` - compaction-bounded history.
- `packages/core/src/session/execution/restart.ts` - managed-service resume.
- `packages/core/src/permission.ts:102` - `findLast` evaluation.
- `packages/core/src/tool.ts:327,500-506` - visibility / `whollyDisabled`.
- `packages/core/src/shell.ts:986` - shell hook.
- `packages/core/src/plugin/module.ts:84-90,152-185` - module shape/loading.
- `packages/core/src/plugin/supervisor.ts` - per-location activation.
- `packages/core/src/config/plugin/source.ts:155` - local path must be a directory.
- `packages/cli/src/shutdown-deadline.ts:5-23` - 10 s deadline.
- `packages/server/src/process.ts:126` - restart continuity only with lifecycle.
- `packages/plugins/figma/index.ts` - official plugin packaging/peer convention.

## Appendix C - Selected observed evidence

Exact event/idle mapping:

```
event.id = evt_2107cbc97001aMgEWlxJ4BY1i7
idle.id  = msg_2107cbc97001aMgEWlxJ4BY1i7
```

Context after success:

```json
[
  { "id": "msg_...", "type": "user", "text": "First question. Answer briefly." },
  { "id": "msg_...", "type": "assistant", "content": [{ "type": "text", "text": "ACK 1" }] },
  { "id": "msg_2107cbc97001aMgEWlxJ4BY1i7", "type": "idle", "outcome": "succeeded" }
]
```

Capture agent tool list with the V1-style ruleset (server prefix included):

```
memoir_memoir_branches, memoir_memoir_commits, memoir_memoir_forget,
memoir_memoir_get, memoir_memoir_recall, memoir_memoir_remember,
memoir_memoir_status, memoir_memoir_summarize, skill
```

After the context hook allowlist:

```
memoir_memoir_branches, memoir_memoir_commits, memoir_memoir_forget,
memoir_memoir_get, memoir_memoir_recall, memoir_memoir_remember,
memoir_memoir_status, memoir_memoir_summarize
```

(With the recommended `memoir_memoir_forget` deny, `forget` is also removed by tool visibility.)

Remote MCP main-agent tool count: 23 direct tools, including 9 Memoir tools; `codemode: false`.

Shutdown observations:

- 15 s cleanup: CLI deadline, exit code 1, `shutdown did not finish within 10s`.
- 2.5 s cleanup: capture interrupted (`Step interrupted`), capture lost.
- 8 s cleanup: capture interrupted, server exit code 143 after about 8.54 s.
- Plain `serve` restart: suspended capture not resumed within 10 s.
