# Minimal Memoir Integration for OpenCode V2

Status: research report only. No production plugin, package, CI, or V1 source change was made.

This report intentionally re-opens the earlier V1-to-V2 analysis. The earlier document's assumptions about MCP checkout, HTTP runtime ownership, and a persistent capture queue do not survive the evidence below.

## 0. Scope, versions, and evidence

### Versions used

| Project | Revision | Notes |
| --- | --- | --- |
| OpenCode | `v2.4.1`, commit `6f0514052a3c859894ad01bb14cc14dda1e44b96` | Latest stable tag and latest npm `@opencode/plugin` / `@opencode/client` / `@opencode/schema` at 2.4.1. |
| Memoir release | `v0.2.9`, commit `0b92609461d8d3ebeacec55ad26d3250b86558e8` | Latest PyPI `memoir-ai` (0.2.9); installed `memoir-mcp 0.2.9`; release date 2026-10-13. |
| Memoir main | `7fd1b3ef704fc554596571d5b9c8b73d7f2b0c5d` | The checkout defect below is still present on main. |
| V1 integration | `v3.3.12` (tag `804876d`), HEAD `2fb56f7` | HEAD contains template-sync commits only. |

### Evidence labels

- **[Source]** read from the pinned release-tagged source.
- **[Verified]** executed against OpenCode 2.4.1 or Memoir 0.2.9 in an isolated environment.
- **[Doc]** upstream documentation or prompt text.
- **[Assumption]** plausible but not experimentally proven; must not be treated as a guarantee.

### Key corrections to the previous research

1. **`memoir_checkout` over MCP is broken in every released MCP version.** It is not a version-specific bug in 0.2.9. The released handler passes a keyword argument the service does not accept, and then reads result fields the result model does not have. This invalidates any architecture that relies on the native MCP tool for branch switching.
2. **A plugin-owned HTTP `memoir-mcp` runtime is not required.** Memoir's MCP tool calls construct services per request; a second process observes an external CLI branch checkout on the next call. With no internal MCP client and a CLI branch switch, a locally registered MCP server is smaller and safer to own.
3. **A persistent capture queue is outside the minimal scope.** The functional requirement is best-effort capture. The adapter needs branch correctness, not durable capture recovery.
4. **Foreground Memoir tool calls are a real branch hazard.** A tool-level branch guard is available through `tool.execute.before`; a capture-only lock is not sufficient for the shared Memoir branch.

### Follow-up update (final)

The follow-up experiments and decisions are integrated in A.7-A.10, C.1, E, F, and G. They supersede several earlier proposals:

- **Do not interrupt a capture for branch sync.** `session.wait` is not a server-completion barrier; a non-yielding MCP handler continued and committed after `session.wait` reported `interrupted`. Branch sync waits for the capture.
- **A terminal capture outcome is not proof that all Memoir tool calls finished.** A configured MCP execution timeout produced a capture that reported both `failed` and, in a second run, `succeeded`, while the timed-out server handler continued and committed ~5 s later. The adapter must audit the capture context: any Memoir tool part whose state is not `completed` means ambiguous termination.
- **Remove `syncedBranch` and status parsing.** Repeated checkout has no data side effects but costs ~450 ms; checkout is performed on actual branch events/captures, not on a cache.
- **Detect A -> B -> A with a branch generation counter**, not a start/end comparison or a turn-tracking subsystem.
- **Use a wait-only `execute.before` guard.** It waits for an active capture/pending sync; it does not checkout, interrupt, or pin the branch through the round trip. It rejects Memoir tools while the location is in an ambiguous or suppressed sync state.
- **Do not overwrite `memoir`.** Register a collision-safe adapter-owned name and derive the capture namespace from it.
- **Patch both upstream prompts.** Onboarding uses a large, explicit upstream rewrite patch, not a separately maintained policy.
- **Do not limit location count artificially.** Document the unsupported combination: same store + different branches, or independent processes on one store.
- **Use `project.canonical` for store identity**, replacing the V1 Git common-directory subprocess.


---

## A. Verified capabilities

### A.1 MCP transport, ownership, and recovery

**Local MCP server** [Verified]
- `ctx.mcp.transform(editor => editor.set("memoir", { type: "local", command: ["memoir-mcp", "--store", store], cwd: store, environment: { MEMOIR_STORE: store }, codemode: false, protocol: "legacy", disabled: false }))` connects successfully.
- OpenCode spawns and owns the child. `/api/mcp` reports `connected` and the server exposes 9 tools.
- Setting `cwd` to the Memoir store and passing both `--store` and `MEMOIR_STORE` works; this matters because Memoir's own onboarding skill warns that its backend can read cwd for git operations.
- `protocol: "legacy"` avoids OpenCode's 2026-07-28 `server/discover` probe. Without it, Memoir's Python MCP SDK logs pydantic validation errors for the probe; the connection still falls back, but the legacy setting is cleaner.
- `codemode: false` exposes direct Memoir tools instead of the Code Mode `execute` wrapper. The capture agent needs direct tools because its permission model denies `execute`.

**Process termination** [Verified]
- Killing the local `memoir-mcp` child produces `status: {status: "failed", error: "Connection closed: MCP server process exited: ..."}`.
- The server is **not** automatically restarted. The MCP tool catalog becomes empty for subsequent model requests; later prompts see no Memoir tools.
- The public plugin MCP domain exposes list/transform/reload, not connect/disconnect. There is no public plugin-level "restart this server" operation.
- This is acceptable for best-effort memory capture but is a real availability limitation for native Memoir tools. The plugin should not build a custom supervisor for it.

**Session expiry vs process crash** [Source]
- `packages/core/src/mcp/connection.ts` distinguishes these: `recovering()` reconnects when a request observes `MCP.SessionExpiredError`, and `onSessionExpired` triggers a background reconnect. This is HTTP session-expiration recovery, not general process recovery.
- A remote HTTP server restarted at the same endpoint can be recovered on the next request through session expiry.
- A local stdio process exit closes the connection and marks it failed; no equivalent restart is implemented.
- Opening a new local process is a native lifecycle operation, not a plugin responsibility.

**Temporary failures** [Source]
- `packages/core/src/mcp/client.ts` retries connection/catalog reads within bounded startup rules. Tool-call failures other than session expiry are surfaced to the caller.
- The adapter should not add a retry layer around MCP tool calls.

**Pooling** [Source]
- `pool: true` only shares connections that negotiate the 2026-07-28 revision; `"legacy"` never shares. Memoir's Python SDK uses the legacy initialize flow here, so each location with the same config gets its own local server.
- The Memoir backend is stateless per tool call; multiple local servers on one store do not carry independent branch state. They still share the store's git HEAD and write lock, so concurrent use from multiple locations/processes remains a Memoir-level concurrency problem.

**Direct MCP tool invocation** [Verified]
- There is no `callTool` on the public plugin MCP domain [Source: `packages/plugin/src/promise/mcp.ts`].
- `ctx.tool.list()` returns registered tools with `id`, raw `name`, and `options.namespace`, including `execute`. Calling a Memoir tool's `execute` with a **real** session context succeeds; calling it with a fabricated session ID fails.
- The public Tool API therefore requires an existing OpenCode session for permission evaluation and MCP calls. There is no session-free administrative call path.
- The adapter should not use `Tool.Info.execute` as an administrative escape hatch. It is not the documented lifecycle, and the only administrative operation needed - branch checkout - is broken in Memoir's MCP handler anyway.

**Lifecycle and cleanup** [Source]
- The local MCP server is part of OpenCode's per-location instance graph. OpenCode starts it, stops it on location/plugin scope close, and tracks the child.
- The plugin's cleanup does not need to own ports, processes, refcounts, or an SDK client.
- The plugin must still dispose its event subscription and runtime hook registrations, and must not block shutdown.
- Active capture sessions are ordinary OpenCode sessions. The plugin must not interrupt a capture for branch sync; on cleanup it aborts events and leaves native shutdown to handle the session. An external interrupt is not a completion barrier (A.7).
- Minimal lifecycle shutdown test: with a local MCP server and a 20 s capture in flight, SIGTERM exited in about 409 ms; no `shutdown did not finish within 10s` message; the `memoir-mcp` child was gone. No V1-style drain is needed.
- OpenCode's CLI has a hard 10 s teardown deadline (`packages/cli/src/shutdown-deadline.ts`). The adapter must not await captures, MCP children, or SDK clients in cleanup; native location shutdown handles the active session, and aborting event/hook delivery is enough. Do not checkout a branch after an external interrupt.

### A.2 Native tool discovery and permissions

**Effective tool identifiers** [Source]
- `packages/core/src/tool/runtime.ts:300-305`:
  - `normalizedName(name)` replaces every non `[A-Za-z0-9_-]` character with `_`.
  - `effectiveName(tool)` is `namespace.replaceAll(".", "_") + "_" + normalizedName(tool.name)` when a namespace exists.
- MCP registration uses `namespace(server) = normalizedName(server)` and `name(server, tool) = effectiveName({name: tool, options: {namespace}})` [Source: `packages/core/src/tool/mcp.ts`].
- The raw Memoir tool name is preserved in `Tool.Info.name`; the effective ID is `id`; the source server is represented by `Tool.Info.options.namespace`.

**Discovery timing** [Verified]
- `ctx.tool.list()` during plugin setup does **not** include MCP tools while the server is still connecting.
- Inside `ctx.session.hook("context", ...)`, after OpenCode's MCP discovery flush, `ctx.tool.list()` includes the Memoir tools with:
  - `id`: e.g. `memoir_memoir_status`
  - `name`: e.g. `memoir_status`
  - `options.namespace`: `memoir`
- A context hook can therefore filter the capture agent's model request to exactly the Memoir server's tools, including future tool additions, without a hardcoded effective-name list.
- OpenCode publishes `mcp.tools.changed` and reloads the tool registry when a catalog changes [Source: `packages/schema/src/mcp-event.ts`, `packages/core/src/tool/mcp.ts`]. The context hook re-reads `ctx.tool.list` per request, so a Memoir tool addition/removal does not require an agent-permission reload or a recursive plugin reload.

**Capture-agent visibility** [Verified]
- With a ruleset `{* deny}, {doom_loop allow}, {memoir_* allow}, {memoir_memoir_checkout deny}`, the model request for a deny-all agent contained the 8 non-checkout Memoir tools plus the built-in `skill` tool.
- The `skill` tool is a visibility exception; execution is denied, but its presence is a leak.
- A session context hook that deletes every key not in the discovered Memoir namespace removed `skill`; the model request then contained only Memoir tools.
- Adding a filter for raw `memoir_checkout` and `memoir_forget` keeps the capture agent away from branch switching and destructive deletion.

**Native rules vs context transformation**
- Native permission rules alone are **not** sufficient: they cannot remove `skill` from a deny-all agent, and a broad wildcard requires knowing the effective prefix before the catalog is available.
- The minimal sufficient boundary is:
  - Agent ruleset: deny `*`, allow a namespace-derived Memoir prefix, deny the effective checkout (and optionally forget) actions.
  - Session context hook: resolve the Memoir namespace tools from `ctx.tool.list()`, remove everything else, and remove the checkout/forget raw names.
- The context hook is narrow: it only mutates `event.tools` when `event.agent === "memoir"`. It does not modify unrelated agents.

**Fixed prefix ownership**
- The adapter owns `memoir`: it always registers `memoir`, uses the fixed `memoir_` effective prefix, and does not hardcode individual effective ids; it filters by `options.namespace === "memoir"` and raw tool name.
- A user-configured MCP server with a different name is not consumed or renamed. A user-defined `memoir` server is overridden at runtime by the plugin while installed; the original configuration is effective without the plugin (see G).

**Tool execution hook** [Verified]
- `ctx.tool.hook("execute.before", ...)` fires for MCP tools. The event includes `tool` (effective id), `info` (with `options.namespace`), `sessionID`, `agent`, `messageID`, `id`, and `input`.
- `packages/core/src/plugin/hooks.ts` states that only `tool.execute.before` has a failure channel: a `Tool.Error` rejects the call before it runs. `packages/core/src/tool.ts:161-237` triggers the hook before execution.
- This is the natural place to enforce branch safety for foreground Memoir tool calls. A generic throw was observed to run the hook, but the supported contract is a `Tool.Error`; the plugin must use that error type.
- The hook must skip the plugin's active capture session; otherwise it would try to take the capture's store lock and deadlock.

**Unrelated agents**
- No agent/command/skill transforms are needed for other agents. The Memoir MCP tools remain native and available to the main agent through ordinary OpenCode discovery.
- The capture agent is the only agent whose tools are filtered.

### A.3 Native VCS branch events

**Event shape** [Verified]
- `vcs.branch.updated` is an ephemeral event (`packages/schema/src/vcs-event.ts`).
- The delivered envelope has `id`, `created`, `type`, `location`, and `data`. The event carries `data.branch` and `location.directory`; unlike session execution events, **location attribution is present**.
- `ctx.vcs.get()` is location-scoped and returns `{ provider, branch: { current, default } }` inside `{ location, data }`.

**Initial state** [Verified]
- At plugin setup, `ctx.vcs.get()` returned `{ branch: {} }` before VCS initialization.
- The first branch event arrived about 150 ms later with the current branch.
- A plugin must not treat the setup-time empty branch as "detached" or "no Git"; it must wait for the first event or re-read VCS after initialization. On plugin reload, `ctx.vcs.get()` may already be populated.

**Ordinary repository and subdirectory** [Verified]
- Changing branches in the repository produced events with the correct branch and the repository location.
- `data.branch` and `ctx.vcs.get().data.branch.current` matched.
- Location directory is the location root, not necessarily the git root; the store path logic must still resolve the git root/common dir.

**Linked worktree** [Verified]
- Booting a location in a linked worktree produced setup with `project.canonical` pointing at the main repository and `location.directory` at the worktree. This is a native way to derive a shared store identity for worktrees without `git rev-parse`.
- The VCS watcher subscribed to `.git/worktrees/<name>/HEAD`.
- Worktree branch changes produced events with `event.location.directory` = worktree and the worktree's current branch.
- The worktree shares the project VCS store; a Memoir store derived from the project canonical is shared by worktrees (A.8).

**Detached HEAD** [Verified]
- `git checkout --detach` produced `data: {}` and `ctx.vcs.get().data.branch.current` undefined.
- No branch name is available to synchronize.

**Non-Git directory** [Verified]
- Setup returned `{ branch: {} }`; no VCS events were produced.
- The adapter must skip branch synchronization.

**Rapid switches** [Verified]
- Multiple branch changes produced multiple events in order. The native VCS service serializes refresh and re-announces the latest branch if publication is overtaken (`packages/core/src/vcs.ts`).
- A consumer should coalesce to the latest branch instead of running one CLI checkout per event; otherwise rapid switches can enqueue out-of-order or redundant checkouts.

**Cross-location delivery** [Verified]
- VCS events are broadcast to every plugin instance in the shared server process, like execution events.
- The project1 plugin instance received a `vcs.branch.updated` event whose `location.directory` was project2. Its own `ctx.vcs.get()` returned project1's branch, not project2's.
- Any VCS consumer must filter `event.location` against `ctx.location` before acting.
- If two locations share a Memoir store (worktrees), ignoring the other location's VCS event is correct for that instance but does not solve the shared-store branch race; see F.

**Watcher behavior**
- The native watcher watches the git HEAD file. If the watcher is disabled/ignored, no `vcs.branch.updated` arrives.
- The adapter can still read `ctx.vcs.get()` at execution start and at the Memoir tool guard, and synchronize before writes. It should not start a polling loop or its own git watcher.

### A.4 Session lifecycle, completed-turn retrieval, and capture

**Execution events** [Verified]
- `session.execution.started` and `session.execution.succeeded` have data `{ sessionID }`; `failed` adds an error; `interrupted` adds a reason.
- The event envelope has `id`, `created`, `type`, `durable`, `data`; session execution events have **no** `location`.
- The success event is delivered after the settlement commit.

**Exact turn identity** [Verified]
- `SessionMessage.ID.fromEvent(event.id)` is used for the idle message (`packages/core/src/session/message-updater.ts:158`).
- Observed pair:
  - `event.id = evt_2107cbc97001aMgEWlxJ4BY1i7`
  - `idle.id = msg_2107cbc97001aMgEWlxJ4BY1i7`
- The exact idle message can be located in `session.context` without selecting "the most recent idle". If the exact idle is absent, the capture must be dropped; the task explicitly forbids falling back to the most recent idle.

**Context shape** [Verified]
- `session.context` returns flat variants:
  - user: `{ id, type: "user", text }`
  - assistant: `{ id, type: "assistant", content: [{ type: "text", text } | { type: "tool", ... }] }`
  - idle: `{ id, type: "idle", outcome }`
- Tool parts and reasoning are not assistant text. Synthetic/system messages are not user messages.
- `session.context` is bounded by the latest completed compaction boundary (`packages/core/src/session/history.ts`). Immediate capture minimizes the risk that the user message is outside the current window.

**Capture session lifecycle** [Verified]
- `ctx.session.create({ title, agent: "memoirprobe" })` creates a root session with no parent.
- `ctx.session.prompt({ sessionID, text, delivery: "queue" })` returns after admission.
- `ctx.session.wait({ sessionID })` resolves when the capture execution settles; `session.get` exposes `outcome: succeeded | failed | interrupted`.
- `ctx.session.remove({ sessionID })` removes the throwaway session.
- `ctx.session.interrupt({ sessionID, resume: false })` interrupts an active capture at an async checkpoint; observed outcome `interrupted` and no memory write before the delayed tool call. It is not a server-completion barrier for a non-yielding write (A.7).

**Model selection** [Verified]
- Omitting `agent.model` uses the session default model; a capture session used the configured local model.
- Setting `agent.model` explicitly overrides it.
- There is no plugin config API for `small_model`/`model`; the V1 fallback chain cannot be preserved without reading config through an unsupported path.
- The capture model is resolved at capture time from `MEMOIR_AGENT_MODEL`, then from `session.model`; if neither is present, the model field is omitted and OpenCode's native default applies. This avoids the setup-time `ctx.model.default()` result, which was observed to be the free model rather than the configured one.
- V1's `temperature: 0` is not expressible in the V2 agent schema without provider-specific request-body overrides. Omit it; a thin adapter should not depend on a provider-specific generation knob. This is a deliberate behavior change from V1.

**Capture behavior**
- The plugin does not need event-based completion bookkeeping for capture: `prompt` + `wait` + `get` replaces the V1 coordinator's accepted/terminal event protocol.
- It does not need a timeout, and it must not interrupt a capture for branch sync. `wait` resolves normally; an external interrupt can leave an in-flight Memoir write, so branch sync waits for normal completion and does not treat an interrupted outcome as a safe release (A.7).
- It must audit the capture context after `wait`: any Memoir tool part not `completed` means ambiguous termination, even if the session outcome is `succeeded` (A.7.1). Terminal outcome alone is not a completion barrier.
- It does not need a persistent queue, retries, recovery, TTL, or transcript storage.

### A.5 Upstream Memoir MCP contract

**Exposed tools** [Verified]
- `memoir_recall(query, limit=10, namespace?, mode="lexical")`
- `memoir_summarize(depth=3, namespace?, prefix?)`
- `memoir_get(keys, namespace="default")`
- `memoir_remember(content, namespace="default", path?, merge_policy?)`
- `memoir_forget(key, namespace="default")`
- `memoir_status()`
- `memoir_branches()`
- `memoir_checkout(target, create=false)`
- `memoir_commits(limit=10)`
- The MCP server instructions describe summarize -> get as the preferred recall flow.

**`memoir_checkout` is broken** [Verified]
- `src/memoir/mcp/server.py:343-350`:
  - calls `BranchService.checkout(target, create=create)`;
  - returns `result.branch`, `result.commit`, `result.created`.
- `BranchService.checkout` signature is `(target, create_branch=None, create_if_missing=False)` (`src/memoir/services/branch_service.py:339-350`).
- `CheckoutResult` has `success`, `target`, `current_branch`, `message`, `error` (`src/memoir/services/models.py:208-225`).
- Actual MCP result:
  - `isError: true`
  - `Error executing tool memoir_checkout: BranchService.checkout() got an unexpected keyword argument 'create'`
- Even if the keyword were fixed, the result attribute reads would raise `AttributeError`.
- Affected tags checked: `v0.1.3` through `v0.2.9`; the broken line is present in every release that contains the MCP server. Current `main` (`7fd1b3e`) is also affected.
- There is no released MCP version with a working `memoir_checkout`.

**Store initialization** [Verified]
- `memoir-mcp --store <path>` creates a store on startup if missing.
- The `memoir` CLI does **not** create a store: `memoir -s <missing> checkout` exits 5 with `Store not found`.
- `memoir --json new <path>` creates an empty store; calling it twice on an empty store returns success. On a store that already has commits, `memoir new` refuses (`Refusing to initialize memoir store ... existing commits`). The adapter therefore checks for an existing `.git` and skips `memoir new`; this was found during implementation.
- On a new empty store, `memoir new` then `memoir checkout -b feature` succeeds; the store ends on `feature` with an initial commit.
- Because the local MCP server's `cwd` should be the store and the store must exist before spawn, the adapter should run `memoir new <store>` before registering the local MCP server only when `<store>/.git` is absent; an existing store is reused.

**Branch semantics** [Verified / Source]
- `memoir checkout -b <branch>` is the CLI's `create_if_missing`: it checks out the branch if it exists, otherwise creates it and checks it out.
- New branches start at the current Memoir HEAD. This is Memoir's existing policy, not a new adapter policy. The adapter must document that a Memoir branch is not anchored at the Git branch point.
- `memoir checkout` exits non-zero on failure (5 for a missing store in the observed case); success is 0.
- The CLI output is available with global `--json` before the subcommand.
- External CLI checkout is visible to a subsequently running MCP server call: after CLI `checkout feature`, `memoir_status` and `memoir_remember` over MCP used `feature`. The MCP server constructs services per call; there is no cross-call branch cache to synchronize.

**Why the V1 branch path did not catch this**
- V1 unit tests mock `memoir_checkout`; they assert the plugin's calls, not the released Memoir handler.
- V1's optional integration smoke asserts a created branch; with any released MCP version, the MCP checkout call fails. The smoke would fail at that assertion against released 0.2.x; V1's unit tests mock the tool, so the defect is not caught there. The optional smoke appears not to have been exercised against the current release.
- This is evidence that the V1 branch mechanism is an untested contract assumption, not a proven behavior to port.

**Other tools**
- `memoir_status` on a new store returns `branch: null`, `initialized: true`, `commit_count: 0`; `memoir_branches` returns `main` as current. The adapter does not need either if it uses `memoir new` + `checkout -b`.
- `memoir_remember` with an explicit `path` skips classification and returns a commit hash. This is the correct capture path: the agent chooses the path, no Memoir classifier call, no custom classification logic.
- `memoir_summarize` is the practical taxonomy discovery operation. It is LLM-free and returns path histograms; the capture prompt can use it to reuse existing paths.

### A.6 Prompt reuse and build-time adaptation

**Capture prompt source** [Source]
- `src/memoir/llm/prompts/capture_coding.tmpl` (51 lines) is the coding-oriented extraction prompt.
- `plugins/claude-code/hooks/prompts/stop_capture.tmpl` is nearly identical but names Claude Code; the coding template is the cleaner upstream source.
- It contains `${TAXONOMY_BLOCK}` (rendered by Memoir's CLI from its taxonomy) and an output protocol of `path<TAB>fact` lines consumed by `memoir capture`.
- Its durable-knowledge, silent-default, trigger, and exclusion guidance is directly reusable.

**Build-time patch experiment** [Verified]
- A 48-line patch with 2 hunks applied to a copy of `capture_coding.tmpl`.
- The patch:
  - replaces "output one line" with "call `memoir_remember` once per fact";
  - replaces `${TAXONOMY_BLOCK}` with optional `memoir_summarize` guidance, path reuse, and explicit permission to create a new top-level path on an empty store;
  - replaces the line/tab protocol with explicit `memoir_remember(content, path)` rules; leaves merge policy to Memoir unless a key is intentionally replaced;
  - keeps the durable/silent/trigger guidance;
  - forbids `memoir_checkout` and `memoir_forget`.
- `patch -p1` applied cleanly; a copy with a changed anchor made one hunk fail (`1 out of 2 hunks FAILED`).
- This is exactly the expected property: explicit, reviewable, and fail-visible on upstream drift.

**Onboarding source** [Source]
- `plugins/codex/skills/memoir-onboard/SKILL.md` (343 lines) and `plugins/claude-code/skills/memoir-onboard/SKILL.md` (328 lines) are the richest onboarding instructions.
- They are skills, not prompts. They assume `PLUGIN_ROOT`, `CLAUDE_PLUGIN_ROOT`/`CODEX_HOME`, helper shell scripts, `uvx` wrappers, `cd "$STORE_PATH"`, a concurrency check, and deterministic `extractors.py` for non-Git `project:onboard`.
- The reusable core is the `codebase:onboard` branch: namespace layout, cold/warm/meta state machine, prompt-vs-code exploration, and `_meta.last_onboard.*` metadata.
- The non-Git `project:onboard` branch depends on deterministic stdlib extractors; reproducing that is outside the adapter's scope and is not required for the V1 command.
- `plugins/claude-code/commands/onboard.md` is a thin slash-command wrapper; it does not carry the procedure.

**License**
- Memoir is Apache License 2.0 (`LICENSE`). Adapted prompt files must retain attribution and license notice.

---

### A.7 In-flight MCP operations, interruption, and store locking

**Questions:** what happens when the MCP operation is already executing, whether `session.interrupt()`/`session.wait()` proves it stopped, whether cancellation reaches the Python server, and how Memoir's store lock interacts with a concurrent CLI checkout.

**Source evidence**

- `tool.execute.before`/`execute.after` bracket tool execution; only `execute.before` can reject the call (`packages/core/src/tool.ts:161-237`, `packages/core/src/plugin/hooks.ts`).
- `session.interrupt` interrupts the execution and returns; it is not documented as waiting for a tool or MCP request to finish (`packages/core/src/session.ts:247`).
- MCP request cancellation is cooperative. The MCP client rejects a cancelled request locally; a server that is in a non-yielding section cannot process the cancellation until it yields.
- Memoir's `ProllyTreeStore.put` takes `store_write_lock`, calls `_follow_head()` under the lock, and commits onto **whatever branch is checked out then** (`src/memoir/store/prolly_adapter.py:387-430`). `BranchService.checkout` calls `store.tree.checkout` without that lock (`src/memoir/services/branch_service.py:339-430`). The file lock serializes writes, not branch selection.

**Experiments**

1. **Interrupt at an async checkpoint** [Verified]. A wrapper around Memoir's `memoir_remember` awaited 10 s before calling the real service. `session.interrupt({resume:false})` while the handler was sleeping produced outcome `interrupted` in ~140 ms; the Python handler received `CancelledError` ~78 ms after it started; no memory was written.
2. **Interrupt during a non-yielding section** [Verified]. The wrapper blocked in `time.sleep(5)` before calling the real service. `session.interrupt` returned `interrupted` and `session.wait` resolved in ~357 ms; about 5 s later the handler completed the sleep, called the real `memoir_remember`, returned success, and committed the memory. The MCP client logged `Received a response for an unknown message ID ...` because it had already cancelled the request. The store contained the memory.
3. **CLI checkout during the handler** [Verified]. With the same blocked handler, `memoir checkout feature` succeeded during the 5 s window. The handler then opened the store and wrote the memory on `feature`; `main` had no memory.

**Conclusions**

- `session.wait()` is **not** a server-side completion barrier. It can report interruption while a non-yielding MCP operation continues.
- `session.interrupt()` must not be used to make a branch safe. It can make the adapter release its lock and switch branches while the old write is still destined for the store.
- Memoir's native write lock does not protect branch selection. A checkout can occur before the write acquires the lock, and the write will follow the newly checked-out HEAD.
- The smallest meaningful guarantee is: **never switch the branch while a capture is in flight; wait for the capture to finish, then synchronize.** The adapter must not interrupt a capture for branch sync.
- The adapter's own store lock is still necessary: it prevents its own VCS sync/capture from checking out during a capture. It cannot protect against an external/manual CLI checkout; that is an inherent limitation.
- An external user/UI interrupt of a capture remains unsafe for branch synchronization. The adapter must not perform an automatic checkout after such an interrupt; document it as unguaranteed.
- `tool.execute.after` is not a server-completion barrier either; it can fire when the client rejects the cancelled call, before the Python handler stops. Do not build a lock held through tool execution on that signal.

**Decision:** branch sync waits for the active capture; no interrupt-based branch switching; no timeout; no capture lock release before `wait` resolves normally. See C.1 and G.4.

### A.7.1 Terminal outcome versus server completion

**Question:** can a capture report `failed` (or even `succeeded`) while a Memoir MCP write is still executing?

**Experiment** [Verified]: the Memoir MCP server was wrapped so `memoir_remember` blocked for 5 s in a non-yielding `time.sleep` before calling the real service; the local MCP config set `timeout: { execution: 1000 }`. A fake model called `memoir_remember`, then either failed the next model request (HTTP 400) or returned a normal completion after the tool error.

- **Failed capture:** the MCP call timed out at ~1 s, the tool part became `error` (`MCP tool "memoir_remember" ... Request timed out`), the next model request failed, and `session.wait` returned `outcome: failed` at ~1.1 s. The server handler completed at ~5 s, called the real `memoir_remember`, returned success, and committed `probe.lock`. The store memory count went from 0 to 1 after the capture had already failed.
- **Succeeded capture:** the same timeout and error tool part, but the fake model returned a normal final text after the tool error. `session.wait` returned `outcome: succeeded` at ~1.1 s, while the server handler committed the memory at ~5 s.
- **Context evidence:** after both terminal outcomes, `session.context` contained the user prompt, an assistant tool part with `name: "memoir_memoir_remember"` and `state.status: "error"` / `Request timed out`, a later assistant text, and the idle marker. The terminal outcome did not encode the outstanding server operation.

**Conclusion:** a Memoir tool part that is `error`, `running`, or `streaming` means the client has no confirmed completion. A `completed` tool part means the MCP result returned and the handler finished; no Memoir tool part means no MCP call was recorded. Terminal outcome alone is insufficient for branch safety.

**Minimal policy:**

- After `session.wait`/`get`, read `session.context` before removing the capture session.
- Classify every Memoir tool part (`type: "tool"`, name under the selected namespace prefix):
  - all `completed`, or no Memoir tool parts => **safe**;
  - any `error`, `running`, `streaming`, or malformed state => **ambiguous**.
- If safe:
  - `succeeded` => allow pending sync;
  - `failed` => allow pending sync (all Memoir calls finished; the failure was elsewhere);
  - `interrupted` => suppress immediate sync, but not permanently unsafe.
- If ambiguous, regardless of `succeeded`/`failed`/`interrupted`:
  - release the lock, do not sync, set a location-scoped in-memory `syncMode = "unsafe"`;
  - subsequent VCS syncs, captures, and foreground Memoir calls are withheld;
  - recovery is a full OpenCode process restart (which stops the local MCP child). Plugin reload is not safe; the child and in-flight handler can survive.
- `syncMode = "suppressed"` is used for a safe `interrupted` capture: immediate sync is withheld, a later matching VCS branch event may retry; foreground Memoir calls are rejected until it does. This is a small in-memory state, not persistent recovery.
- Do not add a timeout, retry, persistent failure state, or MCP supervisor. The ambiguous state is rare (MCP execution timeout/transport failure with an unfinished tool part) and is reported clearly.

### A.8 Store identity

**Verified** with the VCS probe in a subdirectory, a linked worktree, a separate Git directory, and a symlinked path:

| Case | `ctx.location.directory` | `ctx.location.project.canonical` | Store identity |
| --- | --- | --- | --- |
| Ordinary repository | repository path | repository path | project canonical |
| Subdirectory | subdirectory | repository root | repository root |
| Linked worktree | worktree path | main worktree path | main worktree (shared) |
| Separate Git directory | worktree path | worktree path | worktree path |
| Symlink to repository | symlink path | real repository path | real path |
| Explicit `MEMOIR_STORE`/option | any | any | explicit override |

- `project.canonical` is the native equivalent of the V1 Git root/common-directory discovery for ordinary repos, subdirectories, linked worktrees, and symlinks. Use it instead of spawning `git rev-parse`.
- A separate Git directory yields the worktree path, not the external git directory. The V1 common-directory slug would differ; this only matters for migrating an existing V1 store for a separate-git-dir repository. Document; no compatibility layer.
- The store path remains `~/.memoir/<slug(canonical)>` unless overridden.
- Set the local MCP server `cwd` to the store path; create it first with `memoir new`.

### A.9 MCP registration and ownership

**Source:** the MCP editor exposes `list`, `get`, `set`, `update`, `remove` (`packages/plugin/src/promise/mcp.ts`). `normalizedName` preserves `[A-Za-z0-9_-]` and replaces other characters with `_`; `effectiveName` is `${normalizedNamespace}_${normalizedToolName}` (`packages/core/src/tool/runtime.ts:300-305`).

**Verified:** the MCP editor exposes `list`, `get`, `set`, `update`, `remove`; `normalizedName` preserves `[A-Za-z0-9_-]` and replaces other characters with `_`; `effectiveName` is `${normalizedNamespace}_${normalizedToolName}`. A connected `memoir` server exposes `memoir_memoir_branches`, `memoir_memoir_commits`, `memoir_memoir_forget`, `memoir_memoir_get`, `memoir_memoir_recall`, `memoir_memoir_remember`, `memoir_memoir_status`, `memoir_memoir_summarize`, `memoir_memoir_checkout`.

**Ownership rule (implementation):**

1. Always register under the exact name `memoir`; fixed namespace `memoir`; fixed effective tool prefix `memoir_`.
2. On every `ctx.mcp.transform` invocation, including reloads, `editor.set("memoir", config)` unconditionally, overriding any user-defined `memoir` configuration in memory. No store hashing for MCP naming; no generated names or numeric suffixes; no collision detection/resolution; no existing-config comparison or reuse; no dynamic namespace selection.
3. Never modify user configuration files; never modify unrelated MCP servers. When the plugin is absent, OpenCode uses the original user-defined configuration normally.
4. Permissions use `memoir_*`; checkout/forget denied last. Filter tools by `options.namespace === "memoir"` and raw names at request time.
5. Prompts refer to Memoir **tool roles** ("the Memoir remember tool"), never raw/effective tool IDs; onboarding names `memoir` as the selected server.

**Dynamic catalog and reload:** the context hook re-reads `ctx.tool.list()` per request; a Memoir tool addition/removal needs no agent-permission reload. The transform re-applies the full `memoir` configuration on every invocation, so reload does not create a duplicate and a user-added conflicting `memoir` entry is re-overridden.

### A.10 Lifecycle and capture eligibility

- **Title generation** runs inside the session through the title context/model request and publishes title/usage events; it is not a `session.execution.succeeded` turn (`packages/core/src/session/title.ts`, `packages/core/src/session/context.ts:114`). The capture trigger therefore does not see it as a completed conversational execution.
- **Compaction** runs inside the session through the compaction service and publishes `session.compaction.*` events; it is not a separate execution success (`packages/core/src/session/compaction.ts`). A compaction can still bound the context of a real turn; the exact-idle requirement handles that.
- **Capture eligibility** without extra session state: `session.get` provides `agent`, `parentID`, and `location`; `session.context` provides the exact idle and messages. Filter:
  - root (`parentID` absent),
  - non-hidden/non-subagent agent (or absent agent = default),
  - non-`memoir` agent,
  - matching location,
  - a real user message in the exact turn,
  - the exact idle message present.
  This excludes title/compaction work (in-session, not an execution), task children (`parentID`), the capture agent (hidden subagent), and synthetic/empty turns. No separate turn registry is needed.
- **Non-Git/detached** [Verified setup + design]: non-Git has no VCS provider and no branch; detached has provider `git` with no `branch.current`. The public `SessionInfo.location` does not expose a confirmed non-Git marker, so an uninitialized VCS and a confirmed non-Git directory look identical at capture time. Implementation decision: drop both unknown/non-Git and detached captures conservatively; this is documented as a limitation, not a Git detector.
- **Plugin reload with active capture** [Verified]: modifying the plugin file while a capture was in its 8 s sync window produced cleanup of the old instance, setup of the new instance, and the old capture continued; it wrote the memory and the old worker removed the session. The new instance had no active-capture state, and no branch synchronization occurred in this test. A plugin reload is therefore not a safe branch-sync boundary; if the new instance syncs a branch while the old MCP write is in flight, the same in-flight branch race applies. Document as unsupported during an active capture.
- **Cleanup with an active tool** [Verified]: interruption is cooperative (A.7); shutdown kills the local MCP child via OpenCode, and the 20 s capture shutdown test exited in ~409 ms with the child gone. The adapter should abort events, not wait, and must not checkout another branch after an external interrupt.

---

## B. V1 elimination matrix

### B.0 V1 baseline

- V1 is a `{ id, server }` plugin. Its `config` hook starts a plugin-owned HTTP `memoir-mcp`, registers it as a remote MCP server, registers the hidden `memoir` agent and the `memoir:onboard` command. `shell.env` injects `MEMOIR_STORE`.
- Capture is triggered by `chat.message` and reads the **previous** completed turn, deliberately lagging one turn. The capture agent's session has no parent, runs `promptAsync`, and is deleted on terminal idle/error.
- `CaptureCoordinator` owns per-instance submission serialization, branch ownership, dedupe, a 2-attempt retry, and a bounded drain. `MemoirBranchMatcher` reads `memoir_status` and calls `memoir_checkout`, draining active captures before switching.
- The store path is override -> `MEMOIR_STORE` -> git root/common dir -> `~/.memoir/<slug>`; linked worktrees share a store. V2 can simplify the default identity to `ctx.location.project.canonical` (main repo for a worktree), keeping only slug/realpath. The V1 git common-dir subprocess is not required.
- The hidden agent has `*` deny, `doom_loop` allow, `memoir_*` allow, `memoir_memoir_checkout` deny last, temperature 0, steps 8. Model fallback is env -> `small_model` -> `model` -> default.
- V1 has 88 unit tests across 8 files. The tests cover transcript extraction, min chars, dedupe, retries, branch matching, permissions, store paths, MCP runtime lifecycle, and shutdown. The optional integration smoke uses a temporary git project, a local deterministic model, and asserts branch creation, one memory, retry, permissions, and cleanup. Its branch assertion is incompatible with the released MCP checkout defect (the unit tests mock the tool).

### B.1 Architectural evolution and why each decision was made

| V1 transition | Commit / evidence | Reason | V2 consequence |
| --- | --- | --- | --- |
| Custom CLI/memory tools to native MCP | `0e45c6e` removed ~3,534 lines of custom memory-saver/recall code; README says "Instead of wrapping the CLI and re-implementing tools in TypeScript, this plugin registers memoir-mcp..." | Do not reimplement Memoir. | Keep: native MCP only. |
| Local stdio MCP to plugin-owned HTTP MCP | `7c60ab1` | The plugin needed its own client for status/checkout and wanted one process shared with the LLM-facing MCP server; avoid a stdio double spawn. | Obsolete for the minimal adapter: there is no internal client, and the local server is native. |
| Double-prefixed tool names | `31d6d31` | MCP server naming produced `memoir_memoir_*`. | Do not hardcode; resolve namespace/effective ids. |
| Native background job / collapsed child / hidden capture | `d69c56a`, `0454ed4`, `70944d1`, `535cc1f` | V1 had only promptAsync/subtask workarounds; background/collapsed visibility was experimental. | Replace with `session.create` + `prompt` + `wait` + `remove`; no subtask parts, no child UI hacks. |
| Tool catalog injection into capture prompt | `bcd8f54`, removed by `dc8c662` | The injected catalog duplicated static permissions and was noise. | Resolve tools at runtime through `ctx.tool.list`; do not inject a catalog. |
| Snapshot before dispatch / serialize branch and submission | `4d11e9a`, `40c88f2` | V1 read the last turn at the next message; without a snapshot, a later turn could be captured; without serialization, branch matching could interleave with submission. | V2 event ID gives exact turn identity; a store lock serializes branch-changing work. No queue. |
| Track completion, retry background failure | `3e660e1` | V1's promptAsync acceptance/terminal event race lost completions. | V2 `session.wait`/outcome; no retry (best effort). |
| Branch matcher and empty-store handling | `549590f` | `memoir_status` branch `null` was confused with missing status; new stores needed a branch. | CLI `memoir new` + `checkout -b`; no status parser. |
| Hide checkout from the capture prompt | `6ea0b30` | Branch checkout is store-global; the capture agent must not move it. | Context hook removes checkout/forget; native rules deny checkout. |
| Direct `memoir-mcp` console script | `01d0724` | OpenCode's V1 resolver truncated `uvx --python 3.13` arrays. | Keep direct command in local MCP config; no uvx wrapper. |
| Model env rename | `e046353` | V1 needed a model override for capture. | No adapter model; native default. |
| Custom daily logging / debug | `src/debug.ts` | Operational visibility for a complex runtime. | Most of that machinery is unnecessary; keep minimal error logging only. |

### B.2 Component matrix

| V1 component | Original purpose | Why it existed | Minimal V2 / Memoir capability | Decision | Evidence |
| --- | --- | --- | --- | --- | --- |
| `src/mcp-client.ts` (`MemoirRuntime`) | Spawn HTTP server, random port, internal SDK client, reconnect, SIGTERM/SIGKILL | Plugin needed status/checkout plus LLM-facing MCP; one shared process | Local MCP server owned by OpenCode; `memoir` CLI for admin checkout | **Remove runtime** | Local MCP probe; kill/no restart; CLI/MCP statelessness |
| `src/status.ts` | Parse `memoir_status` branch/memory count | Branch matcher needed current store branch | `memoir checkout -b` is idempotent; no read needed | **Remove** | CLI checkout tests |
| `MemoirBranchMatcher` | Serialize status/checkout, drain before switching | Store branch is global; V1 had concurrent captures | CLI sync + per-instance store lock + tool hook | **Replace** | Lock/no-lock experiment |
| `src/capture-coordinator.ts` | Queue, dedupe, accepted/terminal states, retry, drain, shutdown | V1 promptAsync acceptance/completion race; branch ownership | One active capture; exact event ID; wait/outcome; no retry/persistence | **Remove** | Event ID/context/wait/interrupt |
| `src/capture.ts` | Read last completed turn, min chars, dispatch, dedupe | V1 read messages at next user message; no exact execution id | Exact `event.id` -> idle; `session.context`; explicit `memoir_remember`; no min chars | **Simplify** | Context shape; exact idle |
| `src/subagent.ts` | Agent config, permissions, model resolution, promptAsync | V1 agent + throwaway session | `agent.transform`, `session.create/prompt/wait/remove`; capture model resolved from env then session | **Simplify** | Agent/session probes |
| `src/prompts.ts` + `src/prompts/*.tmpl` | Custom capture and onboarding prompts | V1 had no upstream prompt reuse | Patched upstream `capture_coding.tmpl` and onboarding `SKILL.md` | **Replace** | Patch experiments |
| `src/path.ts` | Store derivation, worktree/common dir, symlink-safe | Needed per-project Memoir store | Use `ctx.location.project.canonical` for project identity; keep slug/realpath and `MEMOIR_STORE`/option overrides; drop the git subprocess | **Simplify** | Worktree probe: `project.canonical` = main repo; non-git probe |
| `src/debug.ts` | Always-on daily file log, debug stacks, project slug | Diagnose complex runtime/hook behavior | Minimal host error log; no custom file subsystem | **Remove/reduce** | Research scope |
| `src/index.ts` hooks (`config`, `shell.env`, `chat.message`, `event`, `dispose`) | V1 lifecycle glue | V1 plugin API | `Plugin.define` setup, local MCP transform, agent/command, VCS/execution events, tool/session hooks, bounded cleanup | **Rewrite** | V2 API |
| `MEMOIR_AGENT_MODEL` | Capture model override | V1 model fallback | Explicit capture override ahead of active session model | **Retain** | A.4 |
| V1 `temperature: 0` | Deterministic capture generation | V1 agent config | V2 agent has no portable temperature field; omit | **Remove** | A.4 |
| `MEMOIR_CAPTURE_MIN_CHARS` | Avoid trivial captures | V1 local pre-filter | Upstream prompt's silent-default is the policy; remove local filter | **Remove** | Upstream prompt |
| `MEMOIR_AUTO_SAVE` | Disable capture | Operational control | Keep only as an opt-out; branch sync/onboard remain active | **Retain (single check)** | V1 behavior |
| `MEMOIR_LOG` / `MEMOIR_DEBUG` | File logging/debug | Complex lifecycle | Minimal error logging; no file subsystem | **Remove (optional debug)** | Scope |
| `shell.env` `MEMOIR_STORE` | Shell access to store | Convenience | Onboarding/capture use MCP; branch sync uses CLI internally | **Remove** | Scope |
| `/memoir:onboard` command | Project onboarding | Required V1 functionality | Command `execute` with patched upstream prompt | **Retain/adapt** | Prompt research |
| Hidden session without parent | Invisible capture | V1 API | `session.create` no parent; remove after completion | **Retain concept** | Session probe |
| One Memoir process per store | Avoid double spawn / stale state | V1 internal client | Local server per location, stateless per call; no shared runtime | **Remove shared runtime** | A.1 |

### B.3 What this means

The V1 implementation is mostly **lifecycle compensation**. V2 and Memoir now own the parts V1 had to build:

- OpenCode owns the MCP process, tool registry, sessions, permissions, model selection, VCS monitoring, and shutdown.
- Memoir owns the store, branch creation/checkout semantics (via CLI), memory classification/storage/retrieval/merge, and the MCP tool schemas.
- The adapter owns only project store resolution, native registration, branch synchronization, exact turn selection, the capture session, branch safety, and prompt adaptation.

The one integration capability that is **not** provided by either upstream in a working form is native MCP branch checkout. That is a confirmed defect, not a reason to rebuild V1.

---

## C. Minimal architecture candidates

### C.1 Candidate A - Local MCP + CLI branch sync + wait/capture guard (recommended)

```
Location setup
  store = deriveStorePath(ctx.location.project.canonical)
  memoir new <store>                    # only if <store>/.git is absent; store exists before MCP cwd
  mcp.transform:
    always register `memoir` (fixed namespace, memoir_ prefix; unconditional editor.set on every transform)
    local memoir-mcp, cwd=store, MEMOIR_STORE, --store,
    codemode=false, protocol=legacy
  agent.transform: hidden "memoir", steps 8, namespace-derived permissions
  command.transform: memoir:onboard
  session.hook("context"): capture-agent tool allowlist
  tool.hook("execute.before"): wait-only Memoir-tool guard
  event.subscribe: vcs.branch.updated + session.execution.*
  cleanup: abort events, dispose hooks; do not interrupt/wait for capture

Branch synchronization
  VCS event (location matches) -> update generation + desired branch
  -> syncMode=unsafe: no checkout
  -> syncMode=suppressed: clear to ok (a new explicit branch event retries)
  -> coalesced sync worker awaits the store lock (active capture holds it)
  -> after capture, terminal audit decides safe/ambiguous
  -> syncMode=ok: checkout the latest desired branch
  initial ctx.vcs.get -> same path if available
  no syncedBranch cache, no status parser, no polling

Capture
  execution.started -> record {branch, provider, generation}
  execution.succeeded -> filter root/visible/non-memoir/location
  -> find the exact idle by event.id -> slice the turn
  -> drop if branch/provider/generation changed or no exact idle
  one active capture max
  -> acquire store lock -> revalidate branch/provider/generation (changed => drop)
  -> checkout recorded branch (failure => drop)
  -> create session(agent=memoir) -> prompt -> wait -> outcome
  -> read capture context; audit Memoir tool parts
  -> all completed/no Memoir part = safe; any error/running/streaming = ambiguous
  -> safe succeeded: remove session, release lock, allow pending sync
  -> safe failed: remove session, release lock, allow pending sync, no retry
  -> safe interrupted: remove session, release lock, syncMode=suppressed
  -> ambiguous (any outcome): remove session, release lock, syncMode=unsafe
  no queue, persistence, timeout, recovery
```

**Responsibilities retained:** store path, collision-safe MCP registration, CLI store/branch calls, exact turn extraction, one capture session, branch lock/generation, prompt adaptation.

**Independent state inventory (final):**

| State | Why it exists | Lifetime |
| --- | --- | --- |
| canonical store path | MCP config, CLI, store identity | plugin instance |
| active capture `{sessionID, branch, provider, generation}` | one-capture policy and branch safety | capture lifetime |
| branch generation counter | detect A -> B -> A during a turn | plugin/location lifetime |
| desired branch / pending sync promise | coalesce VCS events and let the tool guard wait | until sync completes |
| `syncMode: ok \| suppressed \| unsafe` | withhold sync/guard/captures after ambiguous or externally interrupted terminal work | plugin instance |
| store lock | serialize capture vs sync/foreground guard | plugin instance |
| execution-start branch records | associate a completed turn with its start branch | until terminal event |

Removed from the proposed architecture: `syncedBranch` cache, `memoir_status` parser, per-call checkout guard, interrupt-on-branch-change, persistent queue, transcript store, retry table, process/port/refcount, MCP overwrite, derived onboarding policy.

**Guarantees:**

- A capture holds the store lock across its session. The adapter's VCS sync waits for it; no adapter checkout can occur during the capture.
- A terminal capture outcome is audited through the capture context. A Memoir tool part that is not `completed` marks the location `unsafe`; no further adapter checkout, capture, or foreground Memoir call is allowed in that plugin instance. A safe interrupted capture marks it `suppressed` until a later matching VCS event.
- Branch sync waits for the capture; this may delay the Memoir branch switch, but it cannot corrupt the capture branch. Branch sync still takes priority for **new** work: no new capture is started on a stale branch.
- The `execute.before` guard only **waits** for an active capture or pending sync for Memoir tools. It does not checkout, does not interrupt, and does not claim to pin the branch through the MCP round trip. It rejects Memoir calls when `syncMode` is `suppressed` or `unsafe`.
- A branch change during a turn is detected by a generation counter; a start/end comparison alone cannot detect A -> B -> A.
- `session.interrupt`/`session.wait` are not used to establish branch safety; A.7 proves they are not server-completion barriers.
- No cache tracks the actual Memoir branch. A manual/external `memoir checkout` can leave the store on a different branch until the next Git branch event or capture. This is documented, not repaired by polling or status parsing.
- Title generation and compaction are in-session work, not separate execution successes; the capture trigger does not treat them as turns.

**Failure modes:** MCP child crash loses tools until OpenCode/user reconnects; capture failure is dropped; a failed capture branch checkout drops the capture; a failed VCS sync/foreground guard leaves the branch unconfirmed and the operation waits/fails rather than intentionally writing elsewhere. An external interrupt of a capture can leave an unobservable in-flight Memoir write; the adapter does not switch branches in response. An MCP tool part that did not complete (including a timeout that the model survived) marks the location unsafe; the adapter withholds all branch-changing work until a full OpenCode restart.

**Maintenance:** small; depends on Memoir CLI checkout, local MCP, and upstream prompt anchors.
**Upstream dependence:** Memoir CLI, MCP tools, prompt text; OpenCode local MCP, VCS events, session/tool hooks.

### C.1.1 Tool-guard decision

The previous report proposed a general `execute.before` branch guard. The follow-up evidence supports only a **wait-only** guard:

- **Prevents:** a foreground Memoir tool call while a capture is active on a different branch, or while a branch sync is in progress. Those calls wait for the lock/sync instead of executing on the capture's branch. It also rejects calls when the terminal audit marked the location `suppressed` or `unsafe`.
- **Does not prevent:** a branch switch in the tiny window before a VCS event is delivered, a manual `memoir_checkout`, or a checkout by another process. It cannot pin the branch through an MCP call.
- **Native VCS sync** does not by itself block a foreground MCP call that happens while a capture holds the store branch. The wait-only guard is the smallest coordination that closes that specific gap.
- **Cost:** no CLI per tool call; no cache; only a promise wait when a capture/sync is active.
- **Deadlock:** the guard must skip the active capture session (the capture worker owns the lock); it must never call checkout or interrupt.
- **Failure:** if the awaited capture/sync is suppressed or unsafe after the terminal audit, throw `Tool.Error` rather than running the Memoir call on an unconfirmed branch. That is a best-effort block, not a server-completion guarantee.
- **Decision:** retain the wait-only guard, narrowly scoped to the Memoir namespace and raw tool names. Remove the checkout/interrupt behavior.

### C.1.2 Branch cache and turn-change state

- Repeated `memoir checkout <active-branch>` was measured at ~440-475 ms per call. It changed no commits, refs, memory, or worktree status; only `HEAD`'s mtime changed. The cost is too high for an unconditional per-tool call but acceptable once per actual branch change/capture.
- With checkout only on VCS events/captures, a `syncedBranch` cache is unnecessary. It would add staleness after a manual checkout.
- A start/end branch comparison cannot detect A -> B -> A. A location-scoped **branch generation** incremented on every matching `vcs.branch.updated`, recorded at execution start and compared at success, detects it without a separate turn-tracking subsystem.
- The adapter tracks the **desired** Git branch (pending sync) and the **generation**; it does not track the actual Memoir branch. Memoir owns that state.

### C.2 Candidate B - Plugin-owned HTTP MCP runtime + internal SDK client

- Start `memoir-mcp --http` in the adapter, register remote MCP, connect an internal MCP SDK client, use it for status/checkout.
- Retains the V1 runtime, port allocation, refcount, reconnect, and process cleanup.
- The internal client's checkout tool is broken in every released Memoir version. It would still need the CLI or a patched upstream.
- It adds a process and lifecycle the adapter does not need; the local MCP server is already stateless and native. **Rejected** for the minimal scope.

### C.3 Candidate C - Local MCP, no CLI, rely on native `memoir_checkout`

- Smallest code, no subprocess.
- **Nonfunctional:** every released MCP checkout fails; branch sync cannot work. **Rejected.**

### C.4 Candidate D - Adapter-owned MCP proxy or patched Memoir

- Wrap `memoir-mcp` with a proxy that fixes the checkout handler, or vendor a patched Python server.
- Not a thin adapter; modifies/reimplements upstream behavior; a maintenance and licensing liability. **Rejected.**

### C.5 Candidate E - One Memoir store per Git branch

- Avoids branch switching by deriving a store per branch.
- Changes Memoir's store/branch model and breaks cross-branch memory/history/merge semantics. **Rejected.**

### C.6 Recommendation

**Candidate A.** It is the smallest architecture that preserves the required behavior with a working branch switch. The adapter's remaining complexity is concentrated in one place: serializing its own branch-changing work around a shared mutable store. The no-lock and in-flight experiments demonstrate that the lock must cover the whole capture and that interrupting a capture is unsafe. The adapter does not attempt to isolate foreground external callers, other locations, or other processes.

### C.7 Explicit non-goals

Do not build:

- an MCP runtime, port allocator, internal MCP SDK client, or ref-counted process registry;
- a persistent capture queue, transcript store, TTL manager, recovery ledger, or retry loop;
- interrupt-based branch synchronization or a `syncedBranch` cache;
- a per-tool-call checkout guard, or a lock held through `tool.execute.after`;
- a custom memory tool, classifier, taxonomy loader, merge/conflict algorithm, or recall injector;
- a skill, extra slash command, or custom LLM client;
- a model override chain, min-chars filter, shell env hook, or daily log subsystem;
- a custom MCP checkout tool, patched upstream server, or proxy;
- multi-location/multi-process branch isolation that Memoir cannot provide;
- an auto-reconnect supervisor for a crashed local MCP server;
- a fallback to the most recent idle message when the exact turn is unavailable;
- SessionStart/recall injection or deterministic non-Git onboarding extractors;
- overwriting an existing user MCP server or a general MCP discovery/reuse manager;
- a separately maintained onboarding policy instead of the upstream patch.

---

## D. Responsibility boundaries

| Responsibility | Owner | Adapter action |
| --- | --- | --- |
| MCP process start/stop, stdio transport, tool registry | OpenCode | Register a local MCP config only |
| MCP tool schemas, memory classification, storage, commit/merge, recall | Memoir | Do not reimplement |
| Branch creation/checkout semantics | Memoir CLI | Invoke `memoir checkout -b`; do not define a new branch policy |
| Store creation | Memoir CLI (`memoir new`) | Idempotent setup call |
| Store path for the project/worktree | Adapter | Derive; pass to MCP and CLI |
| Agent/session/model lifecycle | OpenCode | Create/prompt/wait/remove; set the capture model from the explicit override or the completed session |
| Tool permissions and visibility | OpenCode + adapter hook | Namespace-derived ruleset; exact capture-agent allowlist |
| VCS branch monitoring | OpenCode | Subscribe to `vcs.branch.updated`; read `ctx.vcs.get` |
| Branch synchronization | Adapter (because MCP checkout is broken) | CLI checkout with store lock; wait for active capture; coalesce; no interrupt |
| Capture trigger and turn extraction | Adapter | Exact event/idle/context extraction |
| Capture branch association | Adapter | Record start branch + generation; drop if changed or A -> B -> A |
| Branch safety for foreground tools | Adapter | Wait-only `execute.before` guard; never checkout or interrupt |
| Capture prompt policy | Memoir upstream + adapter patch | Patch build output; no policy reimplementation |
| Onboarding procedure | Memoir upstream + adapter adaptation | Command prompt; no skill/scripts |
| Capture durability/recovery | None (out of scope) | Drop; no queue/persistence |
| Logging/diagnostics | OpenCode/console | Minimal; no custom file subsystem |
| Model selection | OpenCode | Do not override |

Adapter responsibilities that can be **omitted** or delegated:
- MCP runtime ownership, port management, SDK client, reconnect loop.
- Branch status parsing; `checkout -b` is idempotent.
- Capture coordinator, queue, dedupe table, retries, TTL, persistence.
- Custom memory tools/classification/taxonomy/merge.
- Model env, min-chars, shell env, daily log.
- Auxiliary onboarding extractors and SessionStart injection.

Responsibilities that **cannot** be delegated to current upstream:
- Branch synchronization, because the native MCP checkout tool is broken.
- Exact completed-turn extraction, because there is no native "capture this turn" API.
- Waiting for an active capture/pending sync before foreground Memoir calls, because the Memoir store branch is shared mutable state. Full foreground isolation is not achievable.
- Prompt adaptation from line-output CLI to MCP tool calls.

---

## E. Upstream prompt adaptation

### E.1 Capture prompt

**Source:** `src/memoir/llm/prompts/capture_coding.tmpl` at Memoir 0.2.9.

**Required transformations:**

1. Replace the line-output protocol:
   - Upstream: emit `path<TAB>fact` lines; `memoir capture` parses them.
   - Adapter: call the Memoir remember tool once per fact with `content` and an explicit 3-level `path`; leave merge policy to Memoir's default unless the agent has read an existing key and intentionally replaces it.
2. Replace `${TAXONOMY_BLOCK}`:
   - Upstream: Memoir injects taxonomy categories/examples from its CLI.
   - Adapter: the Memoir summarize tool is **optional guidance**, not a prerequisite. The prompt says the agent may use it to reuse an existing path; an empty result or an empty store must not block capture. If no path fits, create a valid 3-level path, including a new top-level category. Do not require a pre-existing top-level and do not invent a taxonomy system.
3. Keep the durable-knowledge guidance:
   - silent default, four durability checks, always-capture triggers, exclusions, one complete fact, third-person, path shape.
4. Add tool restrictions:
   - never `memoir_checkout`; branch selection is host-owned.
   - never `memoir_forget`; capture adds/updates only.
   - no printed report; tool calls are the only effect.
5. Match transcript labels:
   - Format the transcript as `[Human]` / `[Assistant]` (the upstream prompt's labels), or patch the first line to the adapter's labels. This is formatting, not policy.
6. Use tool roles, not effective IDs:
   - The MCP namespace is collision-safe and selected at runtime. The prompt says "the Memoir remember/summarize tools"; it must not contain `memoir_remember`/`memoir_summarize` as required invocation names. The model sees the actual effective tool names in its tool list.

**Contradictory line-output remnants checked:** the adapted prompt must not contain `${TAXONOMY_BLOCK}`, `TAB`, `related_keys`, `CATEGORIES/EXAMPLES`, a path regex, or multi-path comma syntax. Multi-path facts become two Memoir remember calls; the 0-6 fact limit and silent default remain. The final text says "Do not print facts" and uses tool roles, not exact effective IDs.

**Empty store:** the Memoir summarize tool returns an empty histogram; the Memoir remember tool with an explicit new top-level path succeeds and creates a commit. Verified with Memoir 0.2.9 using the raw MCP names; the final prompt wording is namespace-agnostic.

**Build mechanics:**

- Pin Memoir as a Git submodule at `v0.2.9` (`0b92609`).
- Keep the upstream working tree clean.
- Copy the upstream file into a build directory and apply `patches/capture_coding.patch` with `patch --fuzz=0` or `git apply --check`; fail on any hunk failure.
- Generate `dist/prompts/capture-system.txt`.
- Include the Apache-2.0 `NOTICE` and upstream revision.
- The submodule is build-time only.

**Verified:** the prototype patch is 48 lines / 2 hunks; it applied cleanly, a changed anchor failed one hunk, the adapted file has no template placeholders and no CLI invocations, and the empty-store behavior is valid. The prototype names the raw tool IDs; the final patch uses role wording because the MCP namespace is selected at runtime (A.9).

### E.2 Onboarding prompt

**Source choice:** `plugins/codex/skills/memoir-onboard/SKILL.md` at 0.2.9. The Claude Code variant is substantially the same body but adds `context: fork`, `allowed-tools: Bash`, and `CLAUDE_PLUGIN_ROOT`; the Codex variant has the simpler frontmatter and is the cleaner source for a single command prompt. Both are integration-specific; the procedure and namespace layout are shared.

**Mechanism:** a consistent build-time patch, not a separately maintained onboarding policy.

- Copy the upstream SKILL.md into the build directory.
- Apply `patches/memoir_onboard.patch` over the copy; fail the build if an upstream anchor changes.
- The patch removes/replaces:
  - YAML frontmatter, skill registration, `context`/`allowed-tools`, and "invoke the skill" language;
  - `PLUGIN_ROOT`/`CLAUDE_PLUGIN_ROOT`/`CODEX_HOME` discovery and plugin bootstrap;
  - store-path derivation/confirmation and `$MEMOIR`/`uvx` wrappers;
  - `cd "$STORE_PATH"` and all CLI invocations;
  - the concurrency helper and SessionStart injection;
  - deterministic non-Git `extractors.py` and per-file blob machinery.
- It adds OpenCode-specific replacements:
  - Git detection via a native shell command;
  - Memoir get/remember/commits tool calls against the already-bound MCP store;
  - native file/shell tools for exploration;
  - a simple prompt-only `project:onboard` path for non-Git folders;
  - explicit "never checkout/forget" and "no CLI/scripts/skills" rules.
- It preserves the codebase procedure:
  - `codebase:onboard` namespace layout;
  - cold/warm/meta state keyed by code HEAD;
  - `_meta.last_onboard.*` keys, including Memoir HEAD via the Memoir commits tool (limit 1);
  - replace semantics for onboarding keys;
  - bounded modules/goals/rules/lessons/entrypoints/tests/docs/deploy content;
  - small incremental warm rewrites.
- Non-Git:
  - `project:onboard` with a simple overview/tree/totals and meta keys;
  - no deterministic extractors, no helper scripts, no per-file blobs.

**Patch size:** the upstream is 343 lines; the adapted prompt is 138 lines. The resulting patch is 440 lines and a single full-file hunk. It is large but explicit: every removed integration block and every adapted instruction is reviewable, and any upstream change to the source fails the patch instead of silently producing a stale prompt.

**Validated:**

- `patch -p1` applied against `v0.2.9` and produced the adapted prompt byte-for-byte.
- A changed upstream anchor made the hunk fail.
- No `${...}` placeholders remain.
- The only occurrences of `$MEMOIR`, `PLUGIN_ROOT`, `CODEX_HOME`, `uvx`, `extractors.py`, and skill usage are in explicit "do not use" exclusions; there are no invocation instructions.
- The tools are described by role (Memoir get/remember/commits/summarize), and the selected namespace is supplied at runtime; exact effective IDs are left to native tool discovery. The upstream Memoir 0.2.9 MCP schemas are the contracts. The build validator must reject exact `memoir_*` tool identifiers in positive instructions.
- The empty-store codebase path is cold; the Memoir get tool returns not found, and the Memoir remember tool creates a new path.
- No skill registration, helper script, or runtime submodule is required.

**Behavioral validation not performed:** the adapted capture/onboarding prompts were not run against a real model or a real repository; only patch mechanics, tool-schema consistency, empty-store behavior, and prompt-text checks were verified. This is prompt validation, not behavioral validation.

### E.3 Alternatives

| Approach | Pros | Cons | Recommendation |
| --- | --- | --- | --- |
| Submodule + explicit patches for capture and onboarding | One mechanism; upstream changes visible; fail-visible; no runtime dependency; no separate policy | Build-time submodule checkout; onboarding patch is large | **Recommended** |
| Vendor adapted prompts with source SHA and attribution | Simple build | Drift detection manual; provenance weaker | Fallback only |
| Runtime fetch from GitHub | Always latest | Network, reproducibility, supply-chain risk | Reject |
| Reuse V1 prompts only | Smallest | Loses upstream capture/onboarding guidance | Reject |
| Register upstream skills/commands | Native UX | Requires skills/scripts/plugin installs; outside scope | Reject |

---

## F. Verified limitations and blockers

### F.1 Confirmed defects and hard limitations

| Item | Affected versions | Evidence | Consequence |
| --- | --- | --- | --- |
| `memoir_checkout` MCP handler passes `create=` to `BranchService.checkout`, then reads absent result fields | All released MCP versions `v0.1.3`-`v0.2.9` and current main | Source tags; installed 0.2.9; live MCP call error | Native MCP branch switching is unusable; use CLI |
| `session.interrupt` does not wait for the MCP handler to stop | OpenCode 2.4.1 | Non-yielding handler still committed ~5 s after `session.wait` reported `interrupted` | Interrupt cannot be used for branch safety |
| `session.wait` is not a server-completion barrier | OpenCode 2.4.1 | Same experiment; MCP client rejected the late response as an unknown message ID | Capture completion via `wait` does not prove an in-flight write ended after an external interrupt |
| Terminal capture outcome is not a completion proof | OpenCode 2.4.1 + Memoir 0.2.9 | MCP execution timeout 1 s + 5 s non-yielding handler: capture reported `failed` and, in a second run, `succeeded` at ~1.1 s; server committed at ~5 s; context tool part was `error` | Audit all Memoir tool parts; any non-`completed` part is ambiguous |
| MCP cancellation is cooperative | OpenCode 2.4.1 + Python MCP SDK 0.2.9 | Async checkpoint cancelled; blocked sync section continued | A synchronous Memoir write may complete after cancellation |
| `BranchService.checkout` does not take the store write lock | Memoir 0.2.9 source | `src/memoir/services/branch_service.py:339-430`; `src/memoir/store/prolly_adapter.py:387-430` | Native locking serializes writes, not branch selection; a checkout can redirect a later write |
| MCP auto protocol probe causes noisy Python SDK validation errors | Memoir 0.2.9 with OpenCode default `protocol:"auto"` | Server stderr; fallback succeeds | Set `protocol:"legacy"` |
| Local MCP child exit is not automatically restarted | OpenCode 2.4.1 | Kill test; status failed; no tools later | Memoir tools disappear until reconnect/restart; capture best-effort |
| `skill` visible to deny-all agent | OpenCode 2.4.1 | Model tool list | Context hook removes it |
| Execution events lack location and are broadcast to all plugin instances | OpenCode 2.4.1 | Two-location event probe | Filter by session location |
| VCS events are broadcast but carry location | OpenCode 2.4.1 | Two-location VCS probe | Filter `event.location` |
| `session.context` is compaction-bounded | OpenCode 2.4.1 source | Exact idle may be absent after compaction | Drop capture, no fallback |
| Tool execution requires a real session | OpenCode 2.4.1 | Direct `Tool.Info.execute` fake-session test | No session-free admin path |

### F.2 Architectural limitations

1. **Memoir's branch is shared mutable store state.** The adapter can serialize its own captures and branch syncs within one plugin instance. It cannot prevent a foreground Memoir call or another process from checking out a different branch during an in-flight MCP write. The only safe adapter policy is to wait for its own capture to finish before switching branches; it cannot promise isolation for external callers.
2. **Branch synchronization waits behind an active capture.** This delays the Memoir branch change, but avoids `A.7`'s wrong-branch write. Branch sync remains primary for new work: no new capture starts on a stale branch; foreground Memoir calls wait for the active capture/pending sync. The adapter must not interrupt a capture to make sync immediate.
3. **A start/end branch comparison is insufficient for A -> B -> A.** A location-scoped branch generation counter from `vcs.branch.updated` is required; it is small and not a turn-tracking subsystem.
4. **A Memoir branch created for a Git branch starts at the current Memoir HEAD.** It is not anchored at the Git merge base. Existing Memoir policy.
5. **No taxonomy-discovery MCP tool exists.** `memoir_summarize` is optional guidance; capture can create a new top-level path on an empty store.
6. **Onboarding non-Git deterministic extractors are not available through MCP.** The patched prompt retains a simple prompt-only non-Git summary.
7. **Foreground MCP calls outside the plugin's tool hook** (another plugin calling `Tool.Info.execute`, a manual `memoir checkout`, another process) bypass coordination. Even a guarded call is not pinned through the whole MCP round trip. Do not promise full foreground isolation.
8. **Branch synchronization requires the `memoir` CLI as well as `memoir-mcp`.** The CLI is shipped by `memoir-ai[mcp]`; an installation exposing only `memoir-mcp` cannot satisfy branch sync.
9. **No branch cache/status tracking.** A manual Memoir checkout can persist until the next Git branch event or capture. The adapter does not poll or parse `memoir_status` to correct it.
10. **Local MCP process crash is not recoverable through the public plugin API.** No custom supervisor.
11. **Capture sessions may appear briefly** despite the hidden agent; the adapter removes them after completion. A process death can leave an orphan; no recovery.
12. **No capture persistence/recovery.** Crash/shutdown loses in-flight captures. Within scope.
13. **No capture timeout.** A hung capture blocks branch sync/foreground Memoir calls (correctness over liveness). An external interrupt is not a safe release (A.7).
14. **Multiple locations are not the problem; different branches through one store are.** Combinations:
    - different stores: independent, supported;
    - same store, same Git branch: multiple local MCP servers and captures are write-serialized by Memoir; no adapter coordination is required; supported best-effort;
    - same store, different Git branches: shared HEAD, unsupported; no adapter infrastructure can isolate foreground callers;
    - independent OpenCode processes on one store, same branch: Memoir serializes writes; best-effort supported, but there is no adapter coordination;
    - independent OpenCode processes on one store, different branches: unsupported for the shared-HEAD reason.
    Do not artificially limit location count; document the unsupported combinations.
15. **An external interrupt of a capture** (UI stop, shutdown) can leave an unobservable in-flight Memoir write. The terminal audit decides: if all Memoir tool parts are `completed` (or none), `syncMode=suppressed` and a later matching VCS event may retry; if any part is non-completed, `syncMode=unsafe`. The adapter never automatically checkouts after an interrupted outcome; branch correctness after an external interrupt is unguaranteed.
16. **Plugin reload with an active capture** can let the old capture continue while the new instance has no active-capture state. The reload test confirmed the capture completed and was removed by the old worker; no branch sync occurred. Do not treat reload as a safe sync boundary.
17. **Ambiguous terminal tool work blocks the location.** Any Memoir tool part that is not `completed` (including a client timeout after which the model continues) sets `syncMode=unsafe`. Branch sync, new captures, and foreground Memoir calls are withheld; the plugin instance cannot safely resume. Full OpenCode process restart is the only guaranteed recovery because it stops the local MCP child. A plugin reload is not recovery: the old child/handler may survive. This is rare and intentionally conservative.
18. **Prompt behavior is not measured.** The build-time patches are validated mechanically; capture/onboarding quality on a real model and repository is not.

### F.3 Unverified or partially verified assumptions

- Remote HTTP session-expiration recovery is not relevant to the accepted local-MCP architecture and was not re-investigated.
- Title/compaction executions were not triggered; source shows title is an in-session model request and compaction publishes compaction events, not execution successes. The eligibility filter is defensive.
- Non-Git and detached capture behavior is a policy decision, not behaviorally tested.
- Store identity via `project.canonical` is verified for a subdirectory, linked worktree, separate Git directory, symlink, and non-Git location; explicit `MEMOIR_STORE`/option overrides are source/previous tests.
- Multiple locations on the same store with different branches were not run; the shared-HEAD limitation is source/design.
- Plugin reload was tested with a capture but not with a subsequent branch sync.
- MCP process orphan behavior after a hard OpenCode kill is not tested.
- A tool-identifier collision between a padded Memoir namespace and another server/tool pair is theoretically possible; a long hash is the mitigation.
- The terminal audit is verified against a timed-out `memoir_remember`; the full guard/capture/sync behavior in `syncMode=suppressed|unsafe` was not exercised end-to-end. It is a small deterministic state machine to be unit-tested.
- The wait-only tool guard's behavior during an external capture interrupt is not tested; it is documented as unguaranteed.
- The patched onboarding prompt was not executed against a real repository/model.
- The capture prompt was not executed against a real model; empty-store tool behavior and patch text are verified.

### F.4 Optional upstream improvements (not dependencies)

- Fix `memoir_checkout` to use `create_if_missing` and return `CheckoutResult.to_dict()`.
- Add an MCP taxonomy-discovery tool (or expose `memoir_summarize` taxonomy examples).
- Add a per-call branch parameter to `memoir_remember`; this would remove the shared-branch lock for writes.
- Add a native "capture completed turn" event/API or transcript export; not needed now.
- Add a public MCP callTool API; would remove the CLI branch-switch workaround only if checkout were also fixed. The adapter still has no session-independent invocation today.
- Add native local MCP restart control; would improve availability.
- Add an Onboard command/skill bridge; not required.

None of these are prerequisites. The integration must work with current releases.

---

## G. Remaining architectural decisions

### G.1 MCP runtime ownership

- **Alternatives:** local MCP config (OpenCode-owned) vs plugin-owned HTTP runtime + internal client.
- **Evidence:** local MCP connects; Memoir services are stateless per call; CLI checkout is visible; no `callTool`; checkout broken; local process exit not restarted.
- **Recommendation:** local MCP config. Do not build a runtime/refcount/supervisor. Accept that a crashed Memoir MCP server requires reconnect/restart; capture is best-effort.

### G.2 Branch switching interface

- **Decision:** the Memoir CLI is the accepted administrative interface, not a temporary workaround. `memoir new <store>` is used only for a store without `.git`; `memoir checkout -b <branch>` is the supported branch switch; both run with cwd=store and an explicit store.
- Native MCP `memoir_checkout` is broken in every released MCP version. Even if an upstream release fixes it, the public plugin API still has no session-independent tool invocation; the CLI remains the simplest administrative path. Do not build an HTTP runtime or internal client to invoke the tool.
- Do not make the CLI optional; branch sync is a core function.

### G.3 Concurrency scope

- **Do not limit the number of OpenCode locations.** Distinguish:
  - different stores: independent, supported;
  - same store, same Git branch: multiple locations can capture and write; Memoir's write lock serializes writes; the branch is the same; supported best-effort;
  - same store, different Git branches: shared HEAD; unsupported; no adapter layer can isolate foreground callers or other processes;
  - independent OpenCode processes on one store, same branch: Memoir write lock serializes writes; best-effort supported;
  - independent OpenCode processes on one store, different branches: unsupported.
- No process-wide registry, refcount, or store lock across locations. The adapter's lock is per instance; supported cases do not need more, and unsupported cases cannot be fixed by more.
- Document unsupported combinations in the README rather than building infrastructure.

### G.4 Branch conflict policy

- **Decision: wait, do not interrupt.** A VCS branch change coalesces into a pending sync. If a capture is active, the sync waits for the capture to finish, then checks the terminal audit before checking out the latest desired branch. A foreground Memoir call waits for the same lock/pending sync.
- After the capture, audit the capture context. If every Memoir tool part is `completed` (or none exists), the capture is safe: `succeeded` and `failed` allow pending sync; `interrupted` sets `syncMode=suppressed` (no immediate sync; a later matching VCS event may retry).
- Any Memoir tool part that is `error`, `running`, or `streaming` means ambiguous termination, regardless of `succeeded`/`failed`/`interrupted`; set `syncMode=unsafe`, suppress sync and captures, and reject foreground Memoir calls. A full OpenCode restart is the recovery; plugin reload is not safe. A.7.1 shows a timed-out server write committing after both `failed` and `succeeded`.
- Evidence: A.7 experiment 2 shows a non-yielding MCP write continued after `session.wait` reported interrupted; A.7.1 shows the same after an MCP execution timeout and a terminal `failed`/`succeeded` outcome; experiment 3 shows a concurrent CLI checkout redirects that write. Interrupting or trusting the terminal outcome cannot guarantee branch safety.
- Consequences: the Memoir branch switch is delayed by the capture; the foreground Memoir call is delayed; normal non-Memoir work is unaffected. No new capture starts on the stale branch. No timeout; an external interrupt remains unguaranteed.
- Do not introduce a cancellation/timeout mechanism to shorten the wait. The adapter cannot observe the server-side completion after a cancel.

### G.5 Branch association

- Record `{branch, provider, generation}` at `session.execution.started`.
- At `execution.succeeded`, require the exact idle and a real user message; drop if the branch/provider/generation changed. A -> B -> A is detected by generation, not end comparison.
- The capture worker acquires the store lock, revalidates the recorded branch/provider/generation (changed => drop), checks out the recorded branch (failure => drop), then starts the capture. It does not use a cache or status parser.
- After `wait`, audit the capture context's Memoir tool parts before releasing the lock: any part not `completed` => ambiguous => `syncMode=unsafe`; safe `succeeded`/`failed` allow pending sync; safe `interrupted` sets `syncMode=suppressed`.
- Unknown VCS state or non-Git (no confirmed provider/branch) and detached HEAD: drop conservatively; the public session data cannot distinguish an uninitialized VCS from a confirmed non-Git directory. No Git detector is added.
- No fallback to the latest idle if the exact idle is absent.

### G.6 Prompt strategy

- **Decision:** use the same pinned-submodule + copy + explicit-patch mechanism for capture and onboarding.
- Capture: `capture_coding.tmpl` + 48-line patch; optional Memoir summarize tool, new top-level allowed, no merge override, no line protocol; tool roles rather than effective IDs.
- Onboarding: Codex `memoir-onboard/SKILL.md` + 440-line rewrite patch; no skill, no CLI, no extractors, native tools + MCP; simple non-Git prompt.
- Build copy, patch with zero fuzz, fail visibly, no runtime submodule, no upstream working-tree modification, Apache-2.0 NOTICE.
- No separately maintained onboarding policy. The patch is the policy; upstream changes make it fail for review.
- Fallback only if submodules are operationally impossible: vendor the adapted files with source SHA; do not fetch at runtime.

### G.7 Configuration and state

- Keep `MEMOIR_STORE` and `options.store`; keep `MEMOIR_AUTO_SAVE=0` as the capture opt-out (branch sync and onboarding remain).
- Keep `MEMOIR_AGENT_MODEL` as the explicit capture override; remove `MEMOIR_CAPTURE_MIN_CHARS`, `MEMOIR_LOG`, the shell env hook, and the daily log.
- Remove `syncedBranch`, status parsing, polling, and per-call checkout. Do not cache the actual Memoir branch.
- State is limited to C.1's inventory, including the in-memory `syncMode` safety gate; no persistent failure state.
- `protocol:"legacy"`, `codemode:false`, `cwd=store`, explicit store, `memoir new` before MCP.

### G.8 Capture eligibility

- Root session (`parentID` absent), visible non-subagent non-memoir agent (absent agent = default), matching location, real user message, exact idle, branch/provider/generation unchanged.
- Title/compaction are in-session work, not execution successes; task children have `parentID`; the capture agent is a hidden subagent; synthetic turns have no user message. No separate session registry.
- Drop title/compaction/task-child/synthetic/failed/interrupted/incomplete turns.
- This is a deliberate noise reduction from V1's incidental behavior.

### G.9 Detached, non-Git, and unknown VCS behavior

- Non-Git and not-yet-initialized VCS both lack a confirmed provider/branch in the public session data; drop the capture conservatively.
- Detached HEAD has provider git with no branch; drop the capture.
- No adapter checkout in these cases. Branch sync is a no-op.
- This loses non-Git capture, but avoids treating unknown VCS as a confirmed absence of Git. No Git detector is added.

### G.10 MCP registration name

- **Decision:** authoritative `memoir` ownership, no collision handling.
- Always register under the exact name `memoir`; fixed namespace `memoir`; fixed effective tool prefix `memoir_`.
- On every `ctx.mcp.transform` invocation, including reloads, `editor.set("memoir", config)` unconditionally, overriding any user-defined `memoir` configuration in memory.
- Do not modify user configuration files; preserve all unrelated servers; when the plugin is absent, the original user-defined configuration is effective.
- Filter by `options.namespace === "memoir"` and raw names; dynamic catalog.
- Deterministic name + config equality makes reload idempotent; no storage key required.
- Do not generalize to discovery/reuse of arbitrary user Memoir servers.

### G.11 Capture timeout, dedupe, recovery

- No timeout: a hung capture blocks adapter branch sync/foreground waits; an external interrupt is not a safe release. Correctness over liveness.
- No recent-event dedupe: no duplicate live success observed; add a bounded set only if observed.
- No queue, retry, persistence, recovery, TTL, or transcript store.
- No fallback idle.
- `syncMode=unsafe` is in-memory only and ends with the plugin instance/process; it is a safety gate, not a recovery subsystem. Full OpenCode restart is the only guaranteed reset. Plugin reload is not a reset because the old MCP child/in-flight handler may survive.
- A safe `interrupted` capture sets `syncMode=suppressed`; a later matching `vcs.branch.updated` clears it and requests sync. Foreground Memoir calls are rejected while suppressed.

### G.12 Final decision summary

The final architecture is Candidate A with the wait-only guard:

- Local OpenCode-owned Memoir MCP, collision-safe name.
- Memoir CLI for store creation and branch switching.
- VCS events + generation + wait-for-capture lock.
- Terminal capture audit: any non-completed Memoir tool part sets `syncMode=unsafe`; safe results gate sync/captures/foreground calls.
- Exact-turn capture via event/idle and a single hidden session; no queue/retry.
- Patch-based capture and onboarding prompts; no skills.
- No runtime, internal MCP client, status parser, branch cache, interrupt-based sync, overwrite, or multi-process isolation.

### G.13 Implementation-ready component list

A subsequent implementation plan can be organized around these responsibilities:

- `src/index.ts`: `Plugin.define`, setup order, cleanup, event loop.
- `src/store.ts`: `MEMOIR_STORE`/option override; canonical path; slug; `memoir new`.
- `src/mcp.ts`: collision-safe server name, local MCP config, namespace derivation, agent permissions.
- `src/branch.ts`: CLI `checkout -b`, pending sync, VCS location filter, generation counter, `syncMode` gate, automatic-sync suppression.
- `src/capture.ts`: execution start/success handling, eligibility, exact idle, transcript formatting, terminal tool-part audit, one active capture session.
- `src/guard.ts`: wait-only `execute.before` guard for Memoir tools.
- `src/agent.ts`: hidden capture agent definition, tool allowlist hook, `/memoir:onboard` command.
- `prompts/` + build scripts: patched upstream capture and onboarding prompts, attribution, fail-visible patch application.
- Unit tests: store path, naming/normalization, prompt text, generation/eligibility, guard state machine.
- Integration tests: local MCP boot, CLI branch sync, capture, branch/CLI interlock, empty store, naming collision, shutdown.

No additional subsystem is required.

## H. Implementation findings (post-plan)

These findings refine the architecture, not replace it.

- **MCP transform timing:** `ctx.mcp.transform` callbacks can be applied after `setup()` returns. The fixed `memoir` name and `memoir_` prefix need no synchronous reservation; the callback unconditionally sets `memoir`, re-applied on every transform, including reloads. Capture and onboarding are enabled only after this callback confirms the `memoir` registration (`mcpReady`/`onReady`); branch sync may start earlier. `ctx.mcp.reload()` does not guarantee the callback has run before setup continues; it is not a setup barrier.
- **Store creation:** `memoir new` is not idempotent for a store with commits. The adapter checks `<store>/.git` and skips reinitialization, matching Memoir MCP's own `ensure_store` behavior.
- **Non-Git capture:** the public `SessionInfo.location` lacks a workspace/confirmed-non-Git marker and an empty VCS state is indistinguishable from an uninitialized Git repository at capture time. The adapter conservatively drops both. This is a documented limitation; no Git detector is added.

---

## Appendix 1 - Experiment evidence

### Harness

- OpenCode `v2.4.1` Linux x64 binary, run with isolated `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, and `XDG_STATE_HOME`; a fresh database per scenario.
- A local deterministic OpenAI-compatible SSE model; no paid inference. The fake server supports delayed capture responses and forced capture failures.
- Experimental scripts under `/tmp/opencode/memoir-analysis/exp`:
  - `probe-eventid.sh`: event ID -> idle ID, context shape, storage/metadata/VCS.
  - `probe-vcs.sh`, `probe-vcs2.sh`, `probe-vcs3.sh`: ordinary repo, two locations, worktree, non-git, detached, rapid switches.
  - `probe-mcp.sh`: local MCP, tool discovery, context hook, tool hook, process kill.
  - `probe-tool-exec.sh`: direct `Tool.Info.execute` with real vs fake session.
  - `probe-lock-mode.sh lock|nolock`: branch/capture interlock.
  - `probe-interrupt.sh`: interrupt an active capture.
  - `probe-shutdown2.sh`: local-MCP SIGTERM with an active capture.
  - `probe-cancel.sh`, `probe-cancel-branch.sh`: MCP handler cancellation and concurrent CLI checkout.
  - `probe-timeout-failure.sh`, `probe-timeout-failure2.sh`, `probe-timeout-success.sh`: MCP execution timeout while the server handler continues, with terminal `failed` and `succeeded` outcomes.
  - `probe-vcs4.sh`: subdirectory, separate Git directory, and symlink location identity.
  - `probe-name.sh`: user MCP name collision and registration.
  - `probe-reload.sh`: plugin reload with an active capture.
  - `exp-memoir-contract/contract.log`, `cli-sync.log`: MCP contract and CLI/MCP statelessness.
  - `prompt-build/`: capture and onboarding patch apply/fail, empty-store checks.
- These scripts are disposable and are not part of the target repository.

### 1. Memoir MCP contract and checkout defect

Store: `/tmp/opencode/memoir-analysis/exp-memoir-contract/store`.

```
TOOL memoir_checkout schema: { target: string, create?: boolean = false }
CALL memoir_status {} -> { branch: null, initialized: true, ... }
CALL memoir_branches {} -> { branches: ["main"], current: "main" }
CALL memoir_checkout { target: "main", create: false }
  isError=true
  Error executing tool memoir_checkout:
  BranchService.checkout() got an unexpected keyword argument 'create'
CALL memoir_checkout { target: "test-branch", create: true }
  same error
```

Source: `src/memoir/mcp/server.py:343-350`, `src/memoir/services/branch_service.py:339-350`, `src/memoir/services/models.py:208-225`. Affected tags checked `v0.1.3`-`v0.2.9`; main `7fd1b3e` still affected.

### 2. CLI checkout and MCP statelessness

```
memoir branch feature              -> Created branch: feature (current main)
memoir checkout feature            -> Switched to feature
MCP memoir_branches                 -> current feature
MCP memoir_status                   -> branch feature
MCP memoir_remember path=test.feature -> commit on feature
memoir checkout main               -> Switched to main
MCP memoir_status                   -> branch main
MCP memoir_commits                  -> main history only
```

### 3. Store creation and empty-store checkout

```
memoir --json new <path>            -> success on an empty store; second call on an empty store succeeds
memoir --json new <existing-with-commits> -> error (existing git repo with commits)
memoir -s <missing> checkout -b x   -> exit 5, Store not found
memoir new <path>; memoir checkout -b feature
  -> success; status branch=feature, commit_count=1; branches feature, main
```

### 4. Local MCP ownership and lifecycle

```
mcp.transform(local memoir-mcp, cwd=store, MEMOIR_STORE, codemode=false, protocol=legacy)
/api/mcp -> connected, tools=9
capture model request -> 8 Memoir tools (checkout filtered)
kill memoir-mcp -> status failed, "Connection closed: MCP server process exited"
next prompt -> no Memoir tools; no auto-restart
```

Without `protocol:"legacy"`, the same setup logged Python `server/discover` validation errors from OpenCode's auto probe but still connected.

### 5. Tool discovery and permissions

```
ctx.tool.list() at setup -> no MCP tools (still connecting)
ctx.session.hook("context") -> Memoir tools with:
  id=memoir_memoir_*, name=memoir_*, options.namespace=memoir
model request for capture agent after filter -> 8 Memoir tools, no skill/checkout
tool.execute.before -> fires for memoir_memoir_status with namespace=memoir
Tool.Info.execute with a real session -> success
Tool.Info.execute with sessionID=ses_fake -> failure
```

### 6. VCS events

```
setup ctx.vcs.get() -> { branch: {} }
first vcs.branch.updated -> { data: {branch: "feature2"}, location: {directory: project} }
detached HEAD -> { data: {} }, current undefined
worktree -> location.directory=worktree, branch=wtfeature, watcher .git/worktrees/vcs-wt/HEAD
non-git -> setup { branch: {} }, no events
two locations -> project1 plugin received project2 VCS event with event.location=project2
```

### 7. Branch/capture interlock

With a 5 s delayed capture model that calls `memoir_remember`:

- **Lock (`sync:branch`)**: sync command waited for the capture; checkout feature happened after capture; memory `probe.lock` existed on main (and on feature created after main).
- **No lock (`sync:nolock`)**: checkout feature happened while the capture was waiting; memory landed only on feature; main had no memory.
- **Interrupt at an async checkpoint**: `session.interrupt({resume:false})` during the 5 s delay produced outcome `interrupted`, no memory write, and a fast release.

This proves the lock is required. It does not prove that interrupting is safe for branch synchronization; A.7 shows a non-yielding handler continued and wrote after `session.wait` reported interrupted.

### 8. Minimal lifecycle shutdown

With the local MCP plugin and a 20 s delayed capture in flight:

```
capture-start -> SIGTERM -> server exit after ~409 ms
no "shutdown did not finish within 10s"
memoir-mcp child after shutdown: none
```

The adapter did not wait for the capture or the MCP server. OpenCode owned the child and interrupted the session.

### 9. Prompt patches

Capture:

```
patch -p1 < capture_coding.patch  -> apply_rc=0, output identical to patched copy
changed anchor copy -> 1 out of 2 hunks FAILED
```

Onboarding:

```
patch -p1 < onboard.patch         -> apply_rc=0, output identical to adapted prompt
changed upstream anchor            -> 1 out of 1 hunk FAILED
```

The adapted onboarding prompt has no `${...}`, no CLI invocation, no skill/extractor/script
requirement, and uses only `memoir_get`, `memoir_remember`, `memoir_commits`, and optional
`memoir_summarize`.

### 10. In-flight MCP cancellation

- Async checkpoint (10 s `asyncio.sleep`): `session.interrupt` -> `interrupted` in ~140 ms; Python
  handler `CancelledError` at ~78 ms; no memory.
- Non-yielding sync window (5 s `time.sleep`): `session.interrupt` -> `interrupted` in ~357 ms;
  handler completed at ~5 s, called `memoir_remember`, committed memory; client logged an unknown
  message ID for the late response. `session.wait` did not wait for the server operation.

### 11. CLI checkout during an MCP handler

With a 5 s non-yielding handler window:

```
memoir checkout feature          -> success during handler
handler later calls memoir_remember
store branch                    -> feature
feature: probe.lock found       -> true
main: probe.lock found          -> false
```

`ProllyTreeStore.put` takes the write lock and follows the current HEAD; `BranchService.checkout`
does not take that lock. The native lock serializes writes, not branch selection.

### 12. Repeated checkout

`memoir checkout main` x5 on a store already on main:

- 440-475 ms per call.
- No commit, ref, memory, or worktree status change.
- `HEAD` mtime changed; no data-side effect.

A `syncedBranch` cache is not needed for correctness or normal cost; checkout runs only on actual
branch events/captures.

### 13. Store identity

| Location | `project.canonical` |
| --- | --- |
| repository subdirectory | repository root |
| linked worktree | main worktree |
| separate Git directory | worktree path |
| symlink | real repository path |
| non-Git | location path |

`project.canonical` replaces the V1 Git common-directory subprocess for these cases.

### 14. MCP registration and ownership

The adapter owns `memoir`: it always registers `memoir`, uses fixed namespace `memoir` and
`memoir_` prefix, and unconditionally `editor.set("memoir", config)` on every transform,
including reloads, overriding a user-defined `memoir`. Unrelated servers are untouched; user
configuration files are not modified; without the plugin the original configuration is effective.
`normalizedName` preserves `-`/`_` and replaces dots/other characters, but no normalized-name
collision checking is performed.

### 15. Plugin reload with an active capture

About 0.3 s after capture start, modifying the plugin file produced old cleanup and new setup. The
old capture continued in its 8 s sync window, wrote the memory, and the old worker removed the
session. The new instance had no active-capture state; no branch sync occurred. A reload is not a
safe branch-sync boundary.

### 16. Terminal outcome versus server completion

Local MCP execution timeout 1000 ms; a wrapper blocked 5 s in a non-yielding section before calling the real `memoir_remember`.

```
capture context (after wait):
  user text
  assistant tool part name=memoir_memoir_remember state.status=error
    "MCP tool ... failed: Request timed out"
  assistant text
  idle outcome=failed | succeeded

timeline:
  tool call starts
  ~1.0 s  MCP client timeout; tool part error
  ~1.1 s  session.wait returns failed (one run) or succeeded (another run)
  ~5.0 s  Python handler completes and calls real memoir_remember
  ~5.1 s  store contains probe.lock
```

`session.wait`/`get` did not expose the outstanding server operation. The terminal audit of the capture context is the only native signal: the tool part was not `completed`. Both `failed` and `succeeded` were unsafe to treat as completion.

---

## Appendix 2 - Source reference index (OpenCode 2.4.1)

- Plugin lifecycle: `packages/plugin/src/promise/plugin.ts:24-74`.
- MCP domain: `packages/plugin/src/promise/mcp.ts`.
- Local/remote MCP config, protocol, pool: `packages/schema/src/mcp.ts`.
- MCP service lifecycle: `packages/core/src/mcp/index.ts` (`servers`, `connect`, `closed`, startup).
- Session-expiry reconnect: `packages/core/src/mcp/connection.ts`.
- Retry/catalog/execution timeout: `packages/core/src/mcp/client.ts` (`execution` timeout at line 610; default 12 h).
- Stdio process: `packages/core/src/mcp/stdio.ts`.
- Tool IDs/namespaces: `packages/core/src/tool/mcp.ts`, `packages/core/src/tool/runtime.ts:300-305`.
- Tool execution/hook order: `packages/core/src/tool.ts:161-237`.
- Hook failure channel: `packages/core/src/plugin/hooks.ts`; MCP tool errors: `packages/core/src/tool/mcp.ts`.
- Tool domain: `packages/plugin/src/promise/tool.ts`.
- VCS event: `packages/schema/src/vcs-event.ts`; refresh/watcher: `packages/core/src/vcs.ts:120-170`.
- VCS HEAD watcher: `packages/core/src/filesystem/location-watcher.ts`.
- Session events: `packages/schema/src/session-event.ts`; tool part states: `packages/schema/src/session-message.ts`.
- MCP timeout config: `packages/schema/src/mcp.ts:9-17`.
- Idle ID: `packages/core/src/session/message-updater.ts:158`.
- Session API: `packages/core/src/session.ts` (`create`, `context`, `prompt`, `wait`, `interrupt`, `remove`).
- Plugin session wait: `packages/plugin/src/promise/session.ts:225-244`.
- Context compaction: `packages/core/src/session/history.ts`.
- Title generation: `packages/core/src/session/title.ts`, `packages/core/src/session/context.ts:114`.
- Compaction service/events: `packages/core/src/session/compaction.ts`.
- Shutdown deadline: `packages/cli/src/shutdown-deadline.ts`.
- Per-location plugin graph: `packages/core/src/plugin/supervisor.ts`, `packages/core/src/instance.ts`.

## Appendix 3 - Source reference index (Memoir 0.2.9)

- MCP tools and handlers: `src/memoir/mcp/server.py`.
- Checkout defect: `src/memoir/mcp/server.py:343-350`.
- Checkout service signature: `src/memoir/services/branch_service.py:339-350`.
- Checkout result model: `src/memoir/services/models.py:208-225`.
- CLI checkout: `src/memoir/cli/commands/branch.py`.
- CLI store create: `src/memoir/cli/commands/store.py`.
- MCP store ensure: `src/memoir/mcp/server.py` (`ensure_store`).
- Capture prompt: `src/memoir/llm/prompts/capture_coding.tmpl`.
- Store write lock: `src/memoir/store/write_lock.py`; `ProllyTreeStore.put` and `_follow_head`:
  `src/memoir/store/prolly_adapter.py:387-430`.
- Branch checkout without the write lock: `src/memoir/services/branch_service.py:339-430`.
- Claude Code capture prompt: `plugins/claude-code/hooks/prompts/stop_capture.tmpl`.
- Onboarding skill: `plugins/codex/skills/memoir-onboard/SKILL.md`, `plugins/claude-code/skills/memoir-onboard/SKILL.md`.
- License: `LICENSE` (Apache-2.0).

## Appendix 4 - V1 references

- `src/index.ts`, `src/mcp-client.ts`, `src/capture-coordinator.ts`, `src/capture.ts`, `src/subagent.ts`, `src/path.ts`, `src/status.ts`, `src/debug.ts`.
- `tests/index.test.ts`, `tests/capture.test.ts`, `tests/capture-coordinator.test.ts`, `tests/store.test.ts`, `tests/subagent.test.ts`, `tests/mcp-client.test.ts`, `tests/debug.test.ts`, `tests/prompts.test.ts`.
- Commits: `0e45c6e`, `7c60ab1`, `31d6d31`, `d69c56a`, `0454ed4`, `70944d1`, `535cc1f`, `bcd8f54`, `dc8c662`, `4d11e9a`, `40c88f2`, `3e660e1`, `549590f`, `6ea0b30`, `01d0724`, `e046353`.
