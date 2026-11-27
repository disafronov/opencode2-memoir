# Minimal Memoir Integration: Implementation Plan

Status: implementation planning only. No production code, commits, PRs, or CI changes were made.

This plan implements Candidate A from `docs/minimal-memoir-integration-research.md`. It assumes the research, experiments, and decisions in that document unless this plan explicitly refines them.

## 1. Accepted architectural baseline

- OpenCode owns the local Memoir MCP process, tool discovery, tool registry, sessions, model selection, permissions, VCS monitoring, and shutdown.
- Memoir owns the store, branch semantics, memory storage/retrieval/classification/merge policies, MCP tool contracts, and the upstream prompt source.
- The adapter owns only:
  - project store resolution;
  - store initialization through `memoir new`;
  - collision-safe local MCP registration;
  - Git-to-Memoir branch synchronization through `memoir checkout -b`;
  - exact completed-turn extraction;
  - one best-effort background capture;
  - minimal capture/branch/foreground coordination;
  - `/memoir:onboard`;
  - build-time upstream prompt adaptation.
- No V1 HTTP runtime, internal MCP SDK client, port management, process supervision, connection recovery, capture queue, retry, persistence, transcript store, taxonomy implementation, skills, or custom memory tools.
- The Memoir CLI is the accepted administrative interface for store creation and branch switching. The native MCP checkout tool is broken in all released MCP versions and is not used.
- The local MCP server is configured as `type: "local"`, `codemode: false`, `protocol: "legacy"`, `cwd` = store, explicit `--store` and `MEMOIR_STORE`.
- The adapter is a plain plugin setup closure. It uses ordinary functions and a single state object; no service framework, classes, dependency injection container, or extension points.

The accepted decisions in the research report remain fixed:

- No `syncedBranch` cache and no `memoir_status` parser.
- No polling and no independent Git watcher.
- Branch sync waits for an active capture; it does not interrupt it.
- No capture timeout and no interrupt-based branch safety.
- No fallback to the most recent idle message.
- No multi-location branch-isolation infrastructure.
- No overwrite of an existing MCP server.
- One pinned-submodule + explicit-patch mechanism for both prompts.
- Prompt text uses Memoir tool roles, not fixed effective tool IDs.

### 1.1 Final safety amendment

The research report previously left one distinction unresolved: whether a capture that reports `failed` can still have an executing MCP write. The new evidence in `docs/minimal-memoir-integration-research.md` A.7.1 resolves it:

- A configured MCP execution timeout caused a capture to report `failed` at ~1.1 s while a non-yielding Memoir handler completed and committed at ~5 s.
- In a second run, the same timeout and error tool part were present, but the model continued; the capture reported `succeeded` at ~1.1 s and the handler committed at ~5 s.
- The capture context contained a Memoir tool part with `state.status = "error"` and `Request timed out`; the idle outcome was `failed` or `succeeded`.

Therefore terminal outcome is not a completion proof, and the plan uses a terminal tool-part audit before any branch sync or foreground Memoir call.

## 2. Resolution of capture-failure safety

### 2.1 Question and source evidence

**Question:** can a capture report `failed` (or `succeeded`) while a Memoir MCP operation continues?

**Source references:**

- MCP execution timeout: `packages/core/src/mcp/client.ts:610`; schema `packages/schema/src/mcp.ts:9-17`.
- Tool part states: `packages/schema/src/session-message.ts` (`Tool` states `streaming`, `running`, `completed`, `error`).
- MCP tool error mapping: `packages/core/src/tool/mcp.ts`.
- Session terminal outcome: `packages/core/src/session/execution.ts`.
- Memoir write lock and branch follow: `src/memoir/store/prolly_adapter.py:387-430`; checkout does not take the write lock: `src/memoir/services/branch_service.py:339-430`.

### 2.2 Experiment

The disposable experiment is `probe-timeout-failure.sh` / `probe-timeout-success.sh` in `/tmp/opencode/memoir-analysis/exp`.

- The Memoir MCP server was wrapped so `memoir_remember` blocked in a non-yielding `time.sleep(5)` before invoking the real service.
- The local MCP config set `timeout: { execution: 1000 }`.
- The fake model called `memoir_remember`, then either failed the next request with HTTP 400 or returned normal text.

Observed:

| Run | Tool part | Capture outcome | `session.wait` | Server commit | Store |
| --- | --- | --- | --- | --- | --- |
| Failed model | `memoir_remember`, `status: error`, `Request timed out` | `failed` | ~1.1 s | ~5 s | memory present at ~5 s |
| Succeeded model | same error part | `succeeded` | ~1.1 s | ~5 s | memory present at ~5 s |

The capture context after both outcomes contained the tool part with `state.status = "error"`. The idle marker encoded `failed` or `succeeded`; neither encoded the outstanding server operation.

### 2.3 Minimal audit contract

After `session.wait()` and `session.get()`, before `session.remove()`:

1. Read `ctx.session.context({ sessionID: captureSessionID })`.
2. Scan assistant message content for parts with `type: "tool"` whose `name` starts with the selected Memoir effective prefix.
3. A Memoir tool part is confirmed only when `part.state.status === "completed"`.
4. If the context read fails, or any Memoir tool part has `error`, `running`, `streaming`, or a malformed/missing state, the result is **ambiguous**.
5. If there are no Memoir tool parts, or all are `completed`, the result is **safe**.

The prefix is `<normalized-selected-server>_`; the selected server is the adapter-owned hash name (section 6.2). A `doom_loop` tool part is not a Memoir tool part and is ignored.

This audit does not prove that unrelated external clients have stopped. It proves only that every Memoir MCP call initiated by this capture received a completed result. That is the scope of adapter branch safety.

### 2.4 Outcome and sync-mode policy

| Audit | Capture outcome | Pending branch sync | `syncMode` | Foreground Memoir calls | New captures |
| --- | --- | --- | --- | --- | --- |
| safe | `succeeded` | allowed | `ok` | allowed after sync | allowed |
| safe | `failed` | allowed | `ok` | allowed after sync | allowed |
| safe | `interrupted` | suppressed immediately | `suppressed` | rejected until a later matching VCS event | rejected |
| ambiguous | any outcome | withheld | `unsafe` | rejected | rejected |
| context read failure | any | withheld | `unsafe` | rejected | rejected |

`syncMode` transitions:

- `ok` at setup.
- `ok` -> `suppressed` on a safe interrupted capture.
- `suppressed` -> `ok` on a matching `vcs.branch.updated` event; that event requests sync.
- `ok` -> `unsafe` on an ambiguous terminal audit.
- `unsafe` never returns to `ok` within the plugin instance.
- A new capture is not started unless `syncMode === "ok"`.

### 2.5 Behaviors

**Pending branch synchronization**
- `requestSync()` does nothing when `syncMode !== "ok"`.
- A suppressed state is cleared by a later matching VCS event, which then requests the latest desired branch.
- An unsafe state keeps the desired branch and generation updated but never checks out. This is deliberate: a later checkout could redirect the still-running server write.

**Foreground Memoir calls**
- The wait-only tool guard rejects all Memoir calls while `syncMode` is `suppressed` or `unsafe`.
- When `syncMode` is `ok`, it waits for an active capture and pending sync, then permits the call.
- The guard never checks out a branch and never interrupts a capture.

**Subsequent captures**
- A success event is dropped while `syncMode !== "ok"`.
- A capture already active on a different branch keeps the lock; no second capture starts.

**Onboarding**
- `/memoir:onboard` checks `syncMode` and waits for readiness before sending the prompt.
- In `suppressed` or `unsafe`, the command fails with a clear error; it does not send the onboarding prompt.

**Recovery**
- Full OpenCode process restart is the only guaranteed recovery: it stops the local MCP child and the in-flight handler, and a new plugin instance starts with `syncMode = ok`.
- Plugin reload is not recovery: the old MCP child and an in-flight handler can survive. The plan does not persist the unsafe state, so a reload can lose the gate; the plugin docs and logs must mark reload during active/ambiguous work as unsupported.
- A manual MCP process stop/start can also remove the in-flight operation, but the adapter does not implement or auto-detect that as a recovery path. Do not build an MCP supervisor.

**No additional machinery**
- No timeout, retry, queue, persistent failure state, or recovery ledger.
- No cancellation-based sync. The accepted trade-off remains: a capture that never settles delays branch sync and foreground Memoir calls. This is intentional; the user can stop/reload/restart, with the documented consequences.

### 2.6 Constraints and residual limitation

- The audit relies on OpenCode persisting the tool part before `session.wait()` resolves. This is verified for the timeout experiment; the integration test repeats it.
- A tool call that was initiated but never recorded is not detectable. The adapter treats absence of a Memoir tool part as safe because the native context is the only available record. This is a documented limitation, not a reason for a custom journal.
- The audit cannot prove that a **different client/process** did not move the branch. Cross-location/process isolation remains out of scope.
- If the user externally interrupts a capture after all Memoir parts completed, `syncMode=suppressed`; a later VCS event retries. If a part is incomplete, `unsafe`.

## 3. Source and build structure

### 3.1 Current repository

- The target repository is the `semantic-basic-template` state: `README.md`, `CHANGELOG.md`, Apache-2.0 `LICENSE`, `.github/workflows/semantic.yml`, and `.github/workflows/assign-pr.yml`.
- It has no `package.json`, `src`, tests, or build configuration yet.
- The implementation should use the V1 repository's Node/TypeScript conventions (ESM, Node test runner, tsx, esbuild, Biome) without copying V1 architecture.
- Do not modify `.github` in this plan. CI/publishing is a later, separate task. The plan's scripts are local development commands only.
- The existing `docs/` reports are reference material; they are not package input.

### 3.2 Package metadata

Proposed `package.json`:

- `name`: `@zimniy/opencode2-memoir`
- `version`: `0.1.0` initially; semantic-release owns later versions.
- `type`: `module`
- `main`: `dist/index.js`
- `exports`: `{ ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } }`
- `files`: `["dist", "NOTICE", "README.md", "LICENSE"]`
- `license`: `Apache-2.0`
- `engines.node`: `>=24` for build/test; the plugin itself uses Node APIs supported by OpenCode's Bun runtime.
- `peerDependencies`: `{ "@opencode/plugin": "^2.4.1" }`; the official bundled plugin pattern.
- `devDependencies`: `@opencode/plugin` (same range), `@types/node`, `@biomejs/biome`, `esbuild`, `tsx`, `typescript`.
- `dependencies`: none. The adapter does not use the MCP SDK or any Memoir Python package at runtime.
- Scripts:
  - `clean`
  - `build:prompts` - copy/patch/validate upstream prompts
  - `build:types` - `tsc --emitDeclarationOnly`
  - `build:bundle` - esbuild ESM bundle, external `@opencode/plugin`
  - `build` - clean, prompts, types, bundle
  - `typecheck`
  - `lint` / `format` (Biome)
  - `test` - Node test runner via tsx
  - `test:integration`
- `prepublishOnly` may run build + tests later; do not publish now.

### 3.3 Source tree

```
src/
  index.ts       Plugin.define, setup/cleanup, event loop, initial VCS
  state.ts       shared state type, createState, store-lock helper
  store.ts       canonical store resolution, memoir new, CLI runner
  mcp.ts         stable MCP name, local config, normalization, permissions
  agent.ts       capture agent, tool filter, onboarding command
  branch.ts      generation, desired branch, syncMode, sync worker, readiness
  capture.ts     eligibility, exact turn, terminal audit, capture worker
  guard.ts       wait-only execute.before guard
  prompts.ts     generated prompt loader
patches/
  capture-coding.patch
  memoir-onboard.patch
scripts/
  build-prompts.mjs
vendor/
  memoir/        pinned Git submodule; build-time only
tests/
  unit/
  integration/
  fixtures/
```

Root files: `package.json`, `package-lock.json`, `tsconfig.json`, `biome.json`, `Makefile`, `.gitignore`, `NOTICE`, `README.md`, `LICENSE`. Add a minimal Makefile wrapper (`make all` = install, lint, typecheck, build, test) to match the sibling repository convention; it must not add CI.

No `src/cli.ts` is necessary; `store.ts` exports one `runMemoir` function used by store creation and branch checkout. No `src/log.ts`; `console.error` with a fixed prefix and a small `MEMOIR_DEBUG` branch is sufficient. No classes.

### 3.4 Module contracts

#### `src/state.ts`

- **Responsibility:** define the one state object and the per-instance store lock; no behavior beyond creation/lock.
- **Public interface:**
  - `type SyncMode = "ok" | "suppressed" | "unsafe"`
  - `type BranchSnapshot = { branch?: string; provider?: string; generation: number }`
  - `type ActiveCapture = { captureSessionID?: string; branch?: string; provider?: string; generation: number; done: Promise<void> }`
  - `type StartRecord = BranchSnapshot`
  - `type MemoirState = { ... }`
  - `createState(ctx, storePath, storeHash): MemoirState`; `serverName`/`namespace`/`toolPrefix` are unset until MCP registration freezes them.
  - `withStoreLock(state, fn): Promise<T>`
- **Dependencies:** OpenCode Plugin Context type; no runtime dependencies.
- **Owned state:** the type and lock implementation, not the values.
- **Lifecycle:** one state per plugin setup; discarded at cleanup.
- **Why separate:** `index`, `branch`, `capture`, and `guard` need the same type and lock without circular imports.

#### `src/store.ts`

- **Responsibility:** resolve the canonical project store, create it, and run the Memoir CLI.
- **Public interface:**
  - `resolveStore(ctx): { storePath: string; storeHash: string }`
  - `ensureStore(storePath): Promise<void>` (`memoir --json new` only when `.git` is absent)
  - `checkoutBranch(storePath, branch): Promise<{ ok: boolean; stdout: string; stderr: string; code: number }>`
  - `runMemoir(args, cwd, env?): Promise<...>`
- **Dependencies:** `node:fs`, `node:path`, `node:os`, `node:crypto`, `node:child_process`, `MEMOIR_STORE`, `ctx.location.project.canonical`, `ctx.options`.
- **Owned state:** none.
- **Lifecycle:** stateless; called during setup and branch/capture operations.
- **Why separate:** store identity and the only two CLI operations are a coherent unit; it keeps child-process code out of index/branch.

Resolution precedence:

1. `ctx.options.store` if it is a non-empty string.
2. `process.env.MEMOIR_STORE` if non-empty.
3. `~/.memoir/<slug>` where the path is `realpath(ctx.location.project.canonical)` and slug replaces `/` and `.` with `-`.

After `memoir new`, resolve the real store path again and use it consistently for MCP, CLI, and state. `storeHash` is the first 16 hex characters of SHA-256 of the resolved store path.

`runMemoir` uses `execFile("memoir", args, { cwd, env: { ...process.env, MEMOIR_STORE: storePath }, ... })`, no shell and no adapter timeout. A hung CLI blocks the setup/sync/capture/guard that is waiting for it; this is accepted liveness, not a reason to add a cancellation timeout. The OS process can be stopped by the user; the CLI's own exit/failure is handled as a failed operation.

`ensureStore` returns immediately when `<store>/.git` exists; `memoir new` refuses a store with commits. For a missing store it runs `memoir --json new <store>` with cwd set to the store's parent. `checkoutBranch` runs `memoir --json checkout -b <branch>` with cwd set to the store; the `--json` global option must precede the subcommand. Empty stores are supported. A non-zero exit is a failed sync/capture checkout.

#### `src/mcp.ts`

- **Responsibility:** select the adapter-owned MCP name once, build the local config, derive OpenCode's normalized namespace/effective prefix, and produce the capture permission rules.
- **Public interface:**
  - `selectServerName(editor, desiredConfig, storeHash): string`
  - `memoirConfig(storePath): Mcp.ServerConfig`
  - `normalizeServerName(name): string`
  - `toolPrefix(serverName): string`
  - `sameMcpConfig(a, b): boolean`
  - `permissionRules(prefix): Permission.Rule[]`
  - `registerMemoirMcp(ctx, state): Promise<void>`
- **Dependencies:** `ctx.mcp`, `node:crypto`, OpenCode MCP/agent schema types.
- **Owned state:** `state.serverName`, `state.namespace`, `state.toolPrefix`; set at setup and frozen.
- **Lifecycle:** setup only; the transform may re-run on configuration reload but must not rename.
- **Why separate:** collision-safe naming, normalization, and permissions are the highest-risk native-contract code and should be unit-tested independently.

Selection:

- Base name is always `memoir_plugin_<16 hex of canonical store path>`.
- At setup, inspect `editor.list()` and `editor.get()`.
- If the base name is absent, use it.
- If present with exactly the desired config, reuse it (previous adapter registration or an identical user entry).
- If present with a different config, try `_2`, `_3`, ... until absent or identical.
- Freeze the selected name in state. On transform re-run, if the frozen name is now occupied by a different config, do not overwrite; log and skip registration for this instance. A later plugin setup may choose a suffix.
- Never modify any other server.
- Do not use `memoir` as the adapter name. A user-owned `memoir` is preserved; the adapter's prefix is stable and collision-safe.

Namespace:

- Use OpenCode's exact `normalizedName`: replace every character outside `[A-Za-z0-9_-]` with `_`.
- The selected name is safe, so `namespace = selectedName`.
- `toolPrefix = namespace.replaceAll(".", "_") + "_"`.
- Filter tools by `options.namespace === namespace`; identify raw names by `Tool.Info.name`.
- Permission wildcard action: `toolPrefix + "*"`.
- Checkout/forget denies: `toolPrefix + "*memoir_checkout"` / `toolPrefix + "*memoir_forget"` so a collision-resolved suffix remains denied.
- A long hash is the only mitigation for a theoretical server/tool pair that produces the same effective ID; no catalog-wide resolver.

Config:

```
{
  type: "local",
  command: ["memoir-mcp", "--store", storePath],
  cwd: storePath,
  environment: { MEMOIR_STORE: storePath },
  codemode: false,
  protocol: "legacy",
  disabled: false
}
```

`cwd` must exist before the transform; `ensureStore` runs first.

#### `src/agent.ts`

- **Responsibility:** register the hidden capture agent, its context filter, and the onboarding command.
- **Public interface:**
  - `registerCaptureAgent(ctx, state, captureSystemPrompt): Promise<void>`
  - `registerCaptureToolFilter(ctx, state): Promise<Registration>`
  - `registerOnboardCommand(ctx, state, onboardPrompt, awaitReady): Promise<Registration>`
- **Dependencies:** `ctx.agent`, `ctx.session`, `ctx.command`, generated prompts, branch readiness.
- **Owned state:** none; the state namespace/prefix and the prompt text are inputs.
- **Lifecycle:** setup; returned hook registrations disposed in cleanup; command add is idempotent.
- **Why separate:** agent/command tool policy is distinct from branch/capture mechanics; keeping it here makes the capture path readable.

Agent fields:

- id `memoir`;
- name/description;
- `mode: "subagent"`, `hidden: true`;
- `system: captureSystemPrompt`;
- no `steps` override; use native execution defaults;
- no `model`;
- no temperature;
- permissions in this exact order:
  - `{ action: "*", resource: "*", effect: "deny" }`
  - `{ action: "doom_loop", resource: "*", effect: "allow" }`
  - `{ action: prefix + "*", resource: "*", effect: "allow" }`
  - `{ action: prefix + "*memoir_forget", resource: "*", effect: "deny" }`
  - `{ action: prefix + "*memoir_checkout", resource: "*", effect: "deny" }`

Use `editor.update("memoir", ...)`; it creates the agent when missing. Do not touch other agents.

Context filter:

- Only for `event.agent === "memoir"`.
- `const tools = await ctx.tool.list()`.
- Allowed IDs: `tool.options?.namespace === state.namespace`, raw `tool.name !== "memoir_checkout"`, raw `tool.name !== "memoir_forget"`.
- Preserve the native `doom_loop` tool if it is present; it is not a Memoir tool and is the only allowed native control mechanism.
- Delete every key of `event.tools` not in the allowed set; this removes the `skill` visibility exception and any unrelated tools.
- On `ctx.tool.list()` failure, delete all tools and log; a capture with no tools is a lost capture, not a wrong-branch write.
- Never throw from the hook.

Onboarding command:

- Name `memoir:onboard`; add only if `editor.get(name)` is absent.
- `execute`:
  1. If `state.syncMode !== "ok"`, throw a clear Error.
  2. `await awaitReady()`; if it rejects or the mode changes, throw.
  3. Read `input.prompt?.text` (the CommandInvocation prompt is an object; support a string defensively).
  4. Send `onboardPrompt + "\n\nSelected Memoir MCP server: " + state.serverName + "\nUser arguments: " + args` via `ctx.session.prompt({ sessionID: input.sessionID, text, delivery: input.delivery })`.
- The command runs in the current session; no skill, no separate agent, no CLI.

#### `src/branch.ts`

- **Responsibility:** own generation, desired branch/provider, `syncMode`, pending sync, CLI checkout serialization, VCS location filtering, and readiness for the guard/command.
- **Public interface:** `createBranchSync(state)` returns:
  - `observeVcs(event): void`
  - `seed(vcs): void`
  - `requestSync(): void`
  - `awaitReady(): Promise<void>`
  - `afterCapture(outcome, ambiguous): void`
  - `snapshot(): BranchSnapshot`
- **Dependencies:** `ctx.vcs` for seed, `ctx.event` event shape, `store.ts` `checkoutBranch`, `state.ts` lock, logging.
- **Owned state:** `generation`, `desiredBranch`, `desiredProvider`, `syncMode`, `syncWanted`, `syncPromise`, `syncError`.
- **Lifecycle:** created at setup; active until cleanup; no persistence.
- **Why separate:** all branch-state transitions and the wait/suppress/unsafe rules are one deterministic state machine; this is where the safety contract lives.

Event behavior:

- Ignore `vcs.branch.updated` unless `event.location` matches `ctx.location` (directory and workspaceID when present).
- On a matching event:
  - increment `generation`;
  - set `desiredBranch = event.data.branch`;
  - set `desiredProvider = event.data.branch === undefined ? state.desiredProvider : "git"` (a branch event is a VCS branch; the adapter's supported target is Git);
  - if `syncMode === "suppressed"`, set it to `ok` (a new explicit branch event is the retry trigger);
  - if `syncMode === "ok"`, `requestSync()`.
- `seed(vcs)` only when `generation === 0`: provider `git` sets known/provider/branch/generation 1 and requests sync if a branch exists; another provider is known but not synced; a branch without a provider is treated as Git; an entirely empty result stays unknown (not non-Git). Do not overwrite an event that already incremented generation.
- `syncMode === "unsafe"` never changes; desired/generation still update so logs show what was deferred.

Sync worker:

```
requestSync():
  if shuttingDown or syncMode !== "ok": return
  syncWanted = true
  if syncPromise: return
  syncError = undefined
  syncPromise = runSync().finally(() => { syncPromise = undefined; if (syncWanted) requestSync() })

runSync():
  while syncWanted:
    if shuttingDown or syncMode !== "ok": return
    if activeCapture: await activeCapture.done; continue   # do NOT consume syncWanted
    if !desiredBranch: syncWanted = false; return
    if desiredProvider !== "git": syncWanted = false; return
    targetGeneration = generation
    targetBranch = desiredBranch
    outcome = await withStoreLock(state, async () => {
      if shuttingDown or syncMode !== "ok": return "stop"
      if activeCapture: return "retry"
      if generation !== targetGeneration or desiredBranch !== targetBranch: return "retry"
      const result = await checkoutBranch(storePath, targetBranch)
      if (result.code !== 0) { syncError = Error(...); log; return "failed" }
      return "ok"
    })
    if outcome === "stop": return
    if outcome === "retry": continue
    if outcome === "failed":
      if generation !== targetGeneration or desiredBranch !== targetBranch: syncError = undefined; continue
      syncWanted = false; return
    if generation === targetGeneration and desiredBranch === targetBranch: syncWanted = false
  catch: syncError = Error(...); syncWanted = false
```

- A failed checkout is logged and stored as `syncError`; no retry loop. A later VCS event calls `requestSync` again. Do not set `unsafe` for a CLI checkout failure: no MCP write is involved.
- `runSync` catches every exception and records it in `syncError`; `syncPromise` never rejects unhandled. The guard observes the stored error on its next loop.
- `awaitReady()` loops:
  1. if shuttingDown or `syncMode !== "ok"` throw;
  2. if an active capture exists, await its `done` and continue;
  3. if `syncError`, throw;
  4. if `syncPromise`, await it and continue;
  5. if `syncWanted`, call `requestSync()` and continue;
  6. return.
  It never holds the store lock and never checkouts.
- `afterCapture(outcome, ambiguous)` is called by the capture worker before the active capture is cleared:
  - ambiguous => `syncMode = "unsafe"`; `syncWanted = false`; log.
  - safe + `outcome === "interrupted"` => `syncMode = "suppressed"`; `syncWanted = false`; log.
  - safe `succeeded`/`failed` => resume sync only if `syncWanted` is already true from a genuine VCS event; never manufacture a request merely because the capture completed.
- The desired branch/provider and generation update even while suppressed/unsafe; only checkout is withheld.

#### `src/capture.ts`

- **Responsibility:** record execution-start branch associations, decide eligibility, locate the exact turn, run one capture session, audit terminal tool parts, and update branch sync.
- **Public interface:**
  - `recordExecutionStart(state, event): void`
  - `clearExecutionStart(state, sessionID): void`
  - `handleExecutionSucceeded(ctx, state, event): Promise<void>`
  - `clearExecutionStart(state, sessionID): void`; failed/interrupted terminal events clear directly.
- **Dependencies:** `ctx.session`, `ctx.agent`, `state`, `branch`, `store.ts` lock/checkout, logging.
- **Owned state:** `executionStarts`, `activeCapture`.
- **Lifecycle:** created at setup; per-session records are bounded by terminal events; active capture is one; no persistence.
- **Why separate:** turn extraction and terminal audit are the core functional logic and need unit tests independent of plugin wiring.

Execution start:

- Snapshot `branch.snapshot()` (`branch`, `provider`, `generation`) synchronously from the branch state, no `ctx.vcs.get` await.
- Store under `sessionID`; overwrite a previous record for the same session; log if overwritten.
- The capture session's own start is recorded; it is ignored at success.

Success handling:

1. Read and delete the start record; if absent, drop (plugin did not observe the start; no branch association).
2. If `!state.captureEnabled`, `MEMOIR_AUTO_SAVE === "0"`, `state.syncMode !== "ok"`, or `state.shuttingDown`, drop. Auto-save affects capture only; branch sync/onboard remain.
3. If `state.activeCapture`, drop (one active capture).
4. Async eligibility (no capture slot is claimed yet):
   - `const session = await ctx.session.get({sessionID})`; on 404 drop.
   - Reject if location does not match, `parentID` is present, `agent === "memoir"`, or the agent is hidden/subagent via `ctx.agent.get`. Absent agent = default user-facing agent. If the agent lookup fails, drop.
   - `const context = await ctx.session.context({sessionID})`.
   - Exact idle: `idleID = event.id.replace(/^evt_/, "msg_")`; find the idle message with that ID. If absent, drop; no fallback.
   - Find the previous idle index; slice from previous idle + 1 to target idle.
   - Find the last assistant with non-empty text in the slice, then the nearest preceding user in the slice. If either is absent, drop.
   - Format `[Human]\n<user text>\n\n[Assistant]\n<assistant text>`; tool/reasoning content is excluded.
   - Compare the start snapshot with the current branch state:
     - if generation differs, or branch/provider differ, drop;
     - if provider is `"git"` and branch is undefined (detached), drop;
     - if the VCS is unknown, non-Git, or detached, the public API cannot establish a confirmed Git branch; drop the capture conservatively (documented limitation).
5. Re-check `syncMode === "ok"` and `!shuttingDown`.
6. **Claim synchronously:** this step has no `await` between the check and the set. If `state.activeCapture` exists, drop. Otherwise set `activeCapture = { branch, provider, generation, done }` with a deferred `done`, then start `runCapture(...)` without awaiting it in the event loop. Two eligible success handlers cannot both claim; the second sees the active slot and drops. A foreign-location or otherwise ineligible turn never claims the slot.
7. No sync is requested for an ineligible turn. The worker releases the slot and resolves `done` in its `finally`.

Capture worker:

```
await withStoreLock(state, async () => {
  if shuttingDown or syncMode !== "ok": return
  if generation/branch/provider changed from the captured snapshot: return
  if branch !== undefined:
    checkout recorded branch via CLI; failure => return
  const session = await ctx.session.create({ title: "memoir:capture", agent: "memoir" })
  activeCapture.captureSessionID = session.id
  await ctx.session.prompt({ sessionID: session.id, text: transcript, delivery: "queue" })
  await ctx.session.wait({ sessionID: session.id })
  const info = await ctx.session.get({ sessionID: session.id })
  const context = await ctx.session.context({ sessionID: session.id })
  const ambiguous = auditMemoirToolParts(context, state.toolPrefix)
  branch.afterCapture(info.outcome, ambiguous)
  await ctx.session.remove({ sessionID: session.id })
})
finally:
  clear activeCapture; resolve done; release lock
```

- The worker holds the store lock through `wait`; branch sync waits for the active capture and cannot checkout during the capture.
- The worker does not call `session.interrupt` and has no timeout.
- If create/prompt fails before a session exists, no Memoir tool part can exist; treat as a safe failed capture and release (no sync `unsafe`). If a session exists and an unexpected error prevents the context audit, treat as ambiguous (`unsafe`).
- `runCapture` has one error path that always calls `branch.afterCapture` before clearing the active capture:
  - checkout failure before session creation => drop; no MCP call; `afterCapture("failed", false)` and release;
  - session create/prompt failure before any tool => safe failed; `afterCapture("failed", false)`;
  - wait/get/context/audit failure after a session exists => ambiguous; `afterCapture("failed", true)` or the known outcome with `ambiguous=true`;
  - normal path => `afterCapture(info.outcome, auditAmbiguous)`.
  `session.remove` is attempted after the mode update; removal failure is logged and does not change sync mode.
- If the branch checkout fails, drop the capture without creating a session; this is safe (no Memoir call).
- `ctx.session.remove` failure is logged; it does not change the outcome.
- `activeCapture.done` resolves after `afterCapture` and after the active capture is cleared; the branch sync request is queued before the clear (see `afterCapture`) so the guard sees a pending sync.

Terminal audit:

- `auditMemoirToolParts(context, prefix)` returns `safe` or `ambiguous`.
- Flatten assistant `content` parts; select `type === "tool"` and `name.startsWith(prefix)`.
- `safe` iff every selected part has `state?.status === "completed"`.
- No selected parts is safe.
- Any `error`/`running`/`streaming`/missing status is ambiguous.
- A context read failure is ambiguous.
- `doom_loop` is not under the Memoir prefix and is ignored.

Capture eligibility summary:

- `MEMOIR_AUTO_SAVE !== "0"`;
- root, user-facing, non-memoir, matching location;
- exact idle present;
- real user message and assistant text;
- start association present;
- branch/provider/generation unchanged;
- `syncMode === "ok"`;
- one active capture.

Non-Git and detached:
- Non-Git (provider undefined, branch undefined): capture on the current store branch; no checkout; branch sync absent.
- Detached (provider `git`, branch undefined): drop.
- Missing start record or exact idle: drop.
- Empty transcript: drop (no local min-chars threshold).
- Hidden/subagent/title/compaction/task-child/synthetic: drop.

#### `src/guard.ts`

- **Responsibility:** wait-only foreground coordination for Memoir tools.
- **Public interface:** `registerMemoirToolGuard(ctx, state, branch): Promise<Registration>`.
- **Dependencies:** `ctx.tool.hook`, branch readiness, `Tool.Error`.
- **Owned state:** none.
- **Lifecycle:** setup; registration disposed in cleanup.
- **Why separate:** the guard is a separate native hook with a strict no-checkout/no-interrupt contract; keeping it out of capture/branch prevents accidental control flow in those state machines.

Hook:

- On `execute.before`:
  - If `event.info?.options?.namespace !== state.namespace`, return.
  - If `state.activeCapture?.captureSessionID === event.sessionID`, return (the capture agent owns the branch/lock). The parent user session is not exempt; its foreground calls wait.
  - `try { await branch.awaitReady() } catch (error) { throw new Tool.Error({ message: "..." }) }`.
- The guard never calls checkout, never interrupts, and never holds the store lock.
- In `suppressed`/`unsafe`, it throws a clear error; in `ok`, it waits for the active capture/pending sync and then permits the call.
- A runaway capture/CLI sync can delay the guard; this is the accepted liveness trade-off. No timeout.

#### `src/prompts.ts`

- **Responsibility:** load the generated prompts from the package.
- **Public interface:** `loadCapturePrompt(): string`, `loadOnboardPrompt(): string`.
- **Dependencies:** `node:fs`, `node:url`; generated files.
- **Owned state:** none (read at setup; optional module cache).
- **Lifecycle:** setup; static content.
- **Why separate:** keeps filesystem paths/packaging out of agent/capture modules and gives tests one prompt-loading seam.

Paths relative to the built `dist/index.js`: `./prompts/capture-system.txt` and `./prompts/onboard-command.txt`.

#### `src/index.ts`

- **Responsibility:** `Plugin.define`, setup order, state creation, event loop, initial VCS, cleanup.
- **Plugin identity:** `Plugin.define({ id: "opencode2-memoir", setup })`; the id is stable and does not encode the store or selected MCP name. The package is `@zimniy/opencode2-memoir`.
- **Public interface:** default plugin export.
- **Dependencies:** all modules; OpenCode Plugin API.
- **Owned state:** the `MemoirState` instance.
- **Lifecycle:** one per location setup; cleanup on unload/replace.
- **Why separate:** the only file that knows the overall composition; no business logic beyond wiring.

### 3.5 Build-time prompt pipeline

- Add `vendor/memoir` as a Git submodule pinned to `0b92609` (`v0.2.9`). The submodule is build-time only.
- `scripts/build-prompts.mjs`:
  1. Verify `git -C vendor/memoir rev-parse HEAD` equals the pinned revision. Fail on mismatch.
  2. Copy `src/memoir/llm/prompts/capture_coding.tmpl` to a temporary build directory and apply `patches/capture-coding.patch` with a zero-fuzz tool (`git apply --check` then `git apply`, or `patch --fuzz=0`). Apply to the copy only; never mutate the submodule.
  3. Copy `plugins/codex/skills/memoir-onboard/SKILL.md` to the same temporary tree and apply `patches/memoir-onboard.patch`; same zero-fuzz/fail rule.
  4. Validate the generated text.
  5. Write `dist/prompts/capture-system.txt` and `dist/prompts/onboard-command.txt`.
  6. Copy `NOTICE` with the upstream repository, tag, commit, Apache-2.0 attribution, and a summary of modifications.
- The final patches use Memoir tool **roles**, not raw or effective tool IDs. The research prototype patches are the starting point; the final patch text must be updated accordingly.
- Validation (build failure if any fails):
  - no unresolved `${...}` or `{{...}}` placeholders;
  - no `TAXONOMY_BLOCK`, `TAB`, `related_keys`, `CATEGORIES/EXAMPLES`, or line-output regex syntax in the capture prompt;
  - no `PLUGIN_ROOT`, `CLAUDE_PLUGIN_ROOT`, `CODEX_HOME`, `uvx`, `$MEMOIR`, `extractors.py`, `allowed-tools:`, or skill frontmatter in either prompt;
  - no exact `memoir_*` tool identifiers in positive instructions; prompts use "Memoir ... tool";
  - no CLI command invocation instructions (for example `memoir get`/`memoir remember`); generic role wording only;
  - a prompt-contract test maps role phrases to upstream raw tool names (`memoir_get`, `memoir_remember`, `memoir_commits`, `memoir_summarize`) and verifies those tools exist in the pinned `src/memoir/mcp/server.py`.
- Do not copy helper scripts, skills, extractors, or the upstream plugin tree into the package.
- `files` includes only generated prompts under `dist`; the submodule and patches are not runtime dependencies.
- Empty-store and tool-call behavior are integration tests, not build-time text checks.
- Real-model prompt quality is a separate optional evaluation; it is not a build gate.

## 4. Initialization and lifecycle

### 4.1 Setup sequence

All steps are guarded; a setup throw would disable the entire plugin, which is unacceptable.

1. **Resolve options/store**
   - `resolveStore(ctx)`; options override -> `MEMOIR_STORE` -> canonical project path slug.
   - `safeRealpath`; compute `storeHash`.
2. **Initialize store**
   - `ensureStore(storePath)` returns immediately when `<store>/.git` exists; otherwise it runs `memoir --json new <store>`.
   - On failure: log and return a no-op cleanup. No MCP config, no hooks, no branch sync. Do not throw.
3. **Create state**
   - `createState(ctx, storePath, storeHash)`; server/namespace fields are unset.
4. **Register local MCP**
   - Build desired config.
   - `await ctx.mcp.transform` selects/freezes `memoir_plugin_<hash>` and writes `state.serverName`/`namespace`/`toolPrefix`.
   - The transform callback sets `state.mcpReady` and calls `state.onReady`; capture and onboarding remain disabled until this callback confirms the actual selected namespace. Branch sync may start earlier.
   - If the transform fails or the frozen name is occupied with a different config after setup: log and disable MCP-dependent features. Branch sync can still run (CLI only), but capture/onboard cannot.
   - The selected namespace/prefix are known synchronously; MCP discovery is asynchronous and not awaited.
5. **Create branch synchronization state**
   - `createBranchSync(state)`; no sync yet. This must exist before the command/guard closures and before the event loop.
6. **Register capture agent**
   - Permissions derived from prefix; hidden subagent; no steps/model/temperature overrides; system prompt.
   - If it fails: log; capture disabled; branch sync continues.
7. **Register onboarding command**
   - Add `memoir:onboard`; execute uses branch readiness; prompt.
   - If it fails: log; onboarding absent; capture/branch continue.
8. **Register context filter and tool guard**
   - `ctx.session.hook("context")` capture allowlist.
   - `ctx.tool.hook("execute.before")` wait-only guard.
   - Store registrations for cleanup; failures disable the affected feature, not setup.
9. **Start event subscription**
   - `ctx.event.subscribe({ signal, types: ["vcs.branch.updated", "session.execution.started", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"] })`.
   - Start the loop after hooks/agent/command/branch state are registered, before initial VCS seed.
   - The loop is fire-and-forget with catch/log.
10. **Seed initial VCS**
   - `const vcs = await ctx.vcs.get()`; `branch.seed(vcs)`.
   - If `provider/branch` are empty, wait for the first event; do not treat empty as detached.
   - If seed finds a branch and generation is still 0, request sync; the first event may also arrive and coalesce.
11. **Return cleanup**
   - Set `shuttingDown`.
   - Abort the event subscription; dispose all hook registrations.
   - Do not interrupt/wait for an active capture, checkout, or wait for the sync worker.
   - Do not reset `syncMode` or persist state.
   - Catch all errors; cleanup must be quick (native shutdown has a 10 s deadline).

### 4.2 Initialization order rationale

- `memoir new` must precede MCP registration because the local server's `cwd` is the store.
- MCP name/namespace must be frozen before branch/agent permissions and hooks; `ctx.tool.list` is not needed at setup.
- Capture and onboarding are enabled only after the MCP transform callback sets `mcpReady`; the base namespace reservation alone is not enough to expose a capture agent to a possibly different collision-resolved namespace.
- Branch sync state must exist before command/guard/event wiring.
- Agent/command/context/guard must be registered before the event loop starts, so a very early event cannot run against missing state.
- Event subscription must precede `ctx.vcs.get` seed: an event that arrives during setup is captured by the loop; the seed only fills an uninitialized generation.
- Execution events cannot occur before setup completes for a location, but the handlers are registered defensively.
- MCP discovery is asynchronous; no setup path waits for `mcp connected`. The capture context hook flushes/discovery at request time.

### 4.3 MCP registration timing and reload

- `ctx.mcp.transform` callback is synchronous; the selection reads the current editor config and sets the frozen name.
- The transform may run on a configuration reload. It reuses the setup name/config; if the name is now occupied by a different config, it logs and does not overwrite. It does not rename mid-instance. `mcpSelected` records that a name has been frozen; after that, a later transform never selects a new name, even if the frozen entry was lost. A normalized collision with another server also disables MCP features rather than sharing a namespace.
- A plugin reload creates a new setup instance. The setup selects a name again; an identical prior adapter config is reused; a user collision gets a suffix. New agent permissions/context/guard use the new namespace. The old instance's state is gone; reload during an active capture/unsafe state is not a safe boundary (document).
- Do not install a general MCP discovery/reuse manager.
- Do not register a second MCP server for the same store in one instance.

### 4.4 Partial registration and failures

| Failure | Behavior |
| --- | --- |
| Store resolution/new fails | Log; return no-op cleanup; no MCP/agent/command/hooks/events. |
| MCP transform fails or frozen name conflict | Log; no MCP tools; skip capture/onboard; branch sync may still run via CLI. |
| MCP transform succeeds later | Branch sync may already run; `state.mcpReady`/`onReady` enable capture/onboarding only after the selection is confirmed. |
| Agent registration fails | Log; capture disabled; branch sync/onboard? Onboard needs MCP but not the capture agent; command can remain. |
| Command registration fails | Log; onboarding absent; capture/branch continue. |
| Context filter registration fails | Log; capture agent may see `skill`; permissions still deny execution; capture remains best-effort. |
| Tool guard registration fails | Log; foreground Memoir calls are unguarded; document degraded mode. |
| Event subscription fails | Log; no VCS/capture automation; plugin remains loaded but inert. |
| Initial VCS get fails | Log; wait for events; no setup throw. |
| Event loop throws later | Log; no restart; native plugin remains; degraded until reload. |

No setup step may throw out of `setup`.

### 4.5 Cleanup

- `state.shuttingDown = true`.
- `abort.abort()`.
- Dispose tool/session hook registrations; catch each.
- Do not call `session.interrupt`, `session.wait`, `session.remove`, or CLI checkout.
- Active capture/sync promises may still settle; their functions check `shuttingDown` before new checkout/sync and otherwise stop.
- MCP process is OpenCode-owned; no cleanup.
- Full process shutdown kills the child; plugin reload does not, so reload is not a recovery boundary.

## 5. State model and synchronization rules

### 5.1 State inventory

| Variable | Owner | Lifetime | Initialization | Updates | Cleanup |
| --- | --- | --- | --- | --- | --- |
| `storePath` | state | plugin instance | resolve/ensure | never | discarded |
| `storeHash` | state | plugin instance | SHA-256 | never | discarded |
| `serverName`, `namespace`, `toolPrefix` | state | plugin instance | MCP selection | never (frozen) | discarded |
| `mcpSelected` | state | plugin instance | false; true on initial selection | never | discarded |
| `mcpReady`, `onReady` | state | plugin instance | false/undefined; set by transform callback | callback/refresh | undefined, false |
| `generation` | branch | plugin instance | 0; seed sets 1; events increment | every matching VCS event | discarded |
| `desiredBranch`, `desiredProvider` | branch | plugin instance | from seed/events | VCS events | discarded |
| `syncMode` | branch | plugin instance | `"ok"` | capture audit / events | discarded |
| `syncWanted` | branch | plugin instance | false | VCS events, capture completion | false on cleanup |
| `syncPromise` | branch | in-flight sync | null | request/finally | abandoned |
| `syncError` | branch | in-flight/next request | undefined | checkout failure | cleared on next request |
| `captureEnabled` | index/setup | plugin instance | false | true only after MCP transform readiness, agent, context filter, guard, event subscription, and prompt are registered | discarded |
| `activeCapture` | capture | one capture | null | success handler claims synchronously after eligibility; worker sets captureSessionID | cleared in finally |
| `activeCapture.done` | capture | one capture | created at claim | resolved in finally | resolved |
| `executionStarts` | capture | plugin instance | empty Map | started/succeeded/failed/interrupted | entries deleted; map cleared on cleanup |
| `storeLock` | state | plugin instance | resolved promise | capture/sync | abandoned |
| `abort`, hook registrations | index | plugin instance | setup | cleanup | aborted/disposed |
| `shuttingDown` | state | plugin instance | false | cleanup | true |

No `syncedBranch`, no actual Memoir branch cache, no status parser, no persistent pending queue.

### 5.2 Event processing responsiveness

- The event loop never awaits `runCapture`, the sync worker, or a CLI checkout.
- On `succeeded`, it deletes the start record and starts `handleExecutionSucceeded` with `void ...catch(log)`; the handler may read context and then start the worker.
- On VCS events, it updates generation/desired/mode synchronously and calls `requestSync` (fire-and-forget).
- A long capture or sync cannot block later VCS events: they only update state; the sync worker waits for the capture.
- The start snapshot is synchronous from branch state, so a success cannot race an async branch read.

### 5.3 Lock and deadlock rules

- The store lock is held only by the capture worker (through `wait`) and the sync worker's CLI checkout.
- The branch sync worker waits for `activeCapture.done` **without** holding the store lock.
- The guard never acquires the store lock; it waits for active capture/pending sync.
- The capture worker's own Memoir tool calls skip the guard; the worker holds the lock and has already set the branch.
- The sync worker does not wait for the guard; the guard waits for sync.
- No path holds the lock while waiting for a capture or a guard.
- Event loop handlers do not hold the lock.

### 5.4 Required sequences

**Initial branch synchronization**
1. Event loop subscribed; `ctx.vcs.get` returns current branch.
2. `seed` sets generation=1, desired branch/provider; requests sync.
3. Sync worker sees no capture, acquires lock, checks out branch; no cache remains.
4. If `ctx.vcs.get` is empty, no sync; the first VCS event seeds/updates.

**Ordinary branch change**
1. VCS event location matches; generation++, desired branch updated.
2. `syncMode=ok`; request sync.
3. Worker acquires lock (if no capture), checks out; event loop continues.

**Rapid consecutive changes**
1. Each event increments generation and overwrites desired.
2. One sync worker; it reads the latest desired branch and coalesces.
3. If desired changes during a checkout, the loop repeats; no per-event queue.

**A -> B -> A during a turn**
1. Start records generation N and branch A.
2. Events increment to N+1 (B) and N+2 (A).
3. `execution.succeeded` sees generation N+2 != N; drops.
4. No capture; a pending branch sync follows the latest A.
5. If the watcher misses the events, the change is not detected; documented native limitation.

**Successful turn completion**
1. Start record exists; session/user-facing/location checks pass.
2. Exact idle and turn extracted; branch/provider/generation unchanged.
3. Active capture set; worker acquires lock and checks out recorded branch.
4. Capture session prompt/wait/context/audit.
5. Safe succeeded/failed: `afterCapture` resumes only a genuine pending sync before `done`; remove session; release.
6. Sync worker checks out latest desired branch.

**Turn completion while another capture is active**
- Success handler sees `activeCapture`; drops. No queue, no second capture.
- VCS events still update desired/generation; the active capture continues.

**Branch change during active capture**
- VCS event updates desired/generation; request sync.
- Sync worker sees active capture and awaits `done`; it does not checkout or interrupt.
- Capture completes; audit; safe succeeded/failed -> sync latest; safe interrupted -> suppressed; ambiguous -> unsafe.
- The branch switch is delayed; new work does not use a stale branch.

**Foreground Memoir call while sync pending**
- Guard sees namespace; active capture? waits; pending sync? waits; then rechecks mode.
- If mode suppressed/unsafe or sync fails, throws Tool.Error; no checkout, no interrupt.
- If mode ok and sync completes, the tool call proceeds.

**Failed branch checkout**
- Sync worker stores `syncError`, logs; no retry loop; `syncError` remains until the next request.
- Guard awaiting readiness throws Tool.Error; a later VCS event retries.
- Capture worker's recorded-branch checkout failure drops the capture; no MCP write; no unsafe.
- A failed CLI process is a failed checkout; no automatic branch switch.

**Failed, interrupted, or ambiguous capture**
- Safe failed: release; pending sync allowed; no retry.
- Safe interrupted: `syncMode=suppressed`; no immediate sync; later VCS event retries.
- Ambiguous any outcome: `syncMode=unsafe`; no sync/captures/foreground; full restart required.
- Audit runs before `done` resolves; mode is set before the guard sees the release.

**Plugin cleanup**
- `shuttingDown`; abort/dispose; no interrupt/wait/checkout.
- In-flight capture/sync finish or are abandoned by native shutdown; pending states are not persisted.
- MCP process native.
- No recovery.

## 6. Implementation contracts

### 6.1 Store and CLI

- Canonical identity: `ctx.location.project.canonical`, not `ctx.location.directory`; `realpath` and slug; overrides first.
- `memoir new` only when `.git` absent; existing store reused; exit code checked; no store path guessing.
- `checkout -b` uses cwd=store and explicit `MEMOIR_STORE`; exit code checked; no status parsing; no cache.
- The CLI is not optional. Require both `memoir` and `memoir-mcp` from `memoir-ai[mcp]` on PATH. Document.
- No Git subprocess for store identity or branch reading.

### 6.2 MCP registration and permissions

- Stable base hash name fixed synchronously before agent/guard registration; the MCP transform callback (which runs after setup) resolves normalized collisions with a suffix and updates `state.namespace`; the base tool prefix still matches suffixed effective IDs.
- Preserve all user servers; never overwrite.
- Config as section 3.4; `protocol:legacy`, `codemode:false`, `cwd=store`, explicit store.
- Namespace/prefix from exact OpenCode normalization.
- Permissions from prefix; checkout/forget denied last.
- Context filter by namespace + raw names; dynamic catalog; no fixed effective IDs.
- Prompts use tool roles; onboarding prompt includes selected server name at runtime.
- No general MCP discovery/reuse manager; no storage key.
- Reload: identical adapter config reused; different user config at the reserved name => choose a suffix in the transform callback and update `state.namespace`; no overwrite.

### 6.3 Branch synchronization

- VCS events only; location filter.
- Generation for A -> B -> A.
- Desired branch/provider; no actual branch cache.
- Wait for capture; no interrupt.
- `syncMode` gates.
- Coalesced worker; latest desired; no per-event queue.
- Initial seed after subscription.
- CLI failures are liveness errors; guard throws; later event retries.
- No timeout; no polling.

### 6.4 Capture

- Trigger only `session.execution.succeeded`.
- Start record snapshot; no `ctx.vcs.get` in success path (generation catches changes).
- Eligibility as section 3.4.
- Exact idle; no fallback.
- Transcript `[Human]/[Assistant]`; tool/reasoning excluded.
- One active; no queue; no retry; no min chars; no model override.
- Branch checkout failure => drop.
- Wait; context audit; outcome policy.
- Remove session; log removal failure.
- No persistence/recovery.

### 6.5 Guard

- Wait-only; namespace filter; skip active capture session.
- `awaitReady` only; never checkout/interrupt/lock.
- Throw Tool.Error on suppressed/unsafe/failure.
- No timeout; accepted liveness trade-off.
- Dispose registration.

### 6.6 Onboarding

- Command only; no skill.
- Generated upstream patch; roles; selected server name runtime.
- `execute` readiness; current session; input arguments.
- No CLI/helper scripts/extractors.
- Simple non-Git procedure in prompt.
- The onboarding turn may also be captured; best-effort; if it causes noise, no extra policy in the first implementation.

### 6.7 Configuration and documentation

Configuration surface:

- `options.store` (higher priority) and `MEMOIR_STORE` for store override.
- `MEMOIR_AUTO_SAVE=0` disables automatic capture only; branch synchronization and `/memoir:onboard` remain.
- No `MEMOIR_AGENT_MODEL`, `MEMOIR_CAPTURE_MIN_CHARS`, `MEMOIR_LOG`, shell env hook, or custom log file.
- No timeout, queue size, retry, or concurrency tuning options.
- Build/test-only environment variables are not production settings.

README must cover:

- installation of `memoir-ai[mcp]` (both `memoir` and `memoir-mcp` on PATH);
- plugin configuration with `plugins`;
- store resolution and worktree behavior;
- automatic branch synchronization and the wait-during-capture behavior;
- best-effort capture, no persistence/retry;
- `/memoir:onboard` and non-Git behavior;
- unsupported same-store/different-branch concurrency;
- manual/external Memoir checkout behavior;
- ambiguous MCP termination and the full-restart recovery;
- plugin reload is not a safe recovery/sync boundary;
- native MCP process failure/degradation;
- prompt provenance and Apache-2.0 NOTICE;
- the stable adapter MCP server name/prefix and that user `memoir` servers are not overwritten;
- no V1 compatibility layer.

## 7. Test strategy

### 7.1 Unit tests

| Area | Cases |
| --- | --- |
| Store | options > env > canonical slug; symlink; subdirectory/worktree canonical values via fixtures; missing home; store hash stability. |
| CLI | `memoir` args/cwd/env; `new` idempotence calls; `checkout -b` success/failure/exit code; no shell. |
| MCP naming | always hash; identical config reuse; different config suffix; exact normalization (`-`/`_`/dots); no overwrite; frozen name/prompt identity; reload collision disables instead of renaming; actual selected namespace drives filter/guard/onboarding. |
| Permissions | exact rule order; wildcard prefix; checkout/forget last deny; no other agent. |
| Prompt build | patch apply/fail; no placeholders; no raw `memoir_*` in positive prompt; no CLI/helper/skill markers; role-to-upstream-tool contract; generated files packaged. |
| Turn extraction | exact idle; previous-idle boundary; last assistant text + nearest user; tool/reasoning excluded; no exact idle => drop; no user/assistant => drop; A->B->A generation. |
| Eligibility | root/child, hidden/subagent/memoir/default, location, title/compaction in-session, non-Git/detached policy. |
| Audit | all completed/no Memoir => safe; error/running/streaming/missing => ambiguous; context failure; non-Memoir tool ignored; prefix. |
| Sync state | seed/events/generation; rapid coalesce; suppressed->ok; unsafe terminal; failed checkout; no cache; no mode reset on reload. |
| Guard | skip capture session; wait for capture/sync; reject suppressed/unsafe/sync failure; no checkout/interrupt; Tool.Error. |
| Prompt loader | packaged paths; missing file error. |

Unit tests must not mock OpenCode's MCP/agent/session contracts and claim they are verified; pure state functions are tested directly. Upstream Memoir behavior is tested in integration with real releases.

### 7.2 Integration tests

Use the pinned real OpenCode 2.4.1 binary and Memoir 0.2.9; isolated XDG/DB; deterministic local OpenAI-compatible model; no paid inference. Reuse the research harness and scripts where practical.

| Scenario | Assertions |
| --- | --- |
| Local MCP boot | Store created; local server connected; selected hash name; Memoir tools visible to main agent; user `memoir` server preserved. |
| Store/CLI branch | `memoir new`; CLI `checkout -b`; MCP `memoir_status`/remember sees the branch. |
| Initial VCS | Plugin setup syncs the current branch; empty `ctx.vcs.get` path waits for event. |
| Ordinary/rapid branch changes | Branch checked out once per coalesced change; latest branch wins; no stale override. |
| Exact capture | User turn -> capture session -> memory on correct branch; exact idle; capture removed; parent intact. |
| Empty store | First capture creates a new top-level path via Memoir remember; memory exists. |
| Capture agent tools | Only adapter namespace tools; no checkout/forget/skill; direct checkout attempt denied. |
| Branch change during capture | Sync waits; capture memory remains on recorded branch; after capture latest branch syncs. |
| Foreground wait | A main-agent Memoir call during capture/pending sync waits; after sync it runs; no wrong branch. |
| Failed checkout | Sync/guard error; no retry loop; later VCS event retries; capture with failed recorded-branch checkout drops. |
| Ambiguous MCP termination | Test shim returns a Memoir tool error while a background real Memoir write completes later; capture context has error part; adapter sets unsafe; no sync/capture/foreground; memory appears later; full restart resets. |
| Capture failure | Safe model failure with completed/no Memoir tool part; sync allowed; no retry. |
| Interrupt | Async checkpoint interrupt -> safe interrupted => suppressed; no immediate sync; later VCS retries. |
| Non-blocking MCP non-yield | Real slow wrapper/timeout evidence; adapter audit; no branch switch. |
| Existing MCP config | User `memoir`/similar servers preserved; hash server added; no overwrite; tool IDs. |
| Shutdown | Active 20 s capture; SIGTERM exits <10 s; no deadline message; MCP child gone; no adapter drain. |
| Store identity | Subdirectory, worktree, separate Git dir, symlink, explicit override. |
| MCP crash | Child kill => status failed; no auto-restart; capture/onboard degrade; branch CLI still works. |
| Empty/auto-save | `MEMOIR_AUTO_SAVE=0` disables capture, branch sync/onboard remain. |
| Prompt behavior | Separate optional real-model/repo evaluation; not part of deterministic CI, and not used to claim memory quality. |

Test fixtures:

- `tests/fixtures/fake-model.mjs`: deterministic SSE; can call a named Memoir tool, return a tool error, fail after a tool, or complete; logs requests/tool lists.
- `tests/fixtures/slow-memoir-mcp`: test-only `memoir-mcp` shim on a temp PATH. It wraps the real Memoir handler: for the ambiguity scenario, return a tool error while starting a delayed real `memoir_remember` (or block in a thread) so the store write happens after the capture terminal outcome. It is not packaged and does not change the production MCP config.
- For the real timeout, the research wrapper remains evidence; the integration adapter audit test uses the shim error/late write. If a short MCP execution timeout is needed, it can be set in the test's plugin config only through a test fixture variant; do not add a production timeout setting solely for tests.
- `tests/integration/harness.ts`: starts the server, waits for `/api/config` 200, creates sessions, prompts, reads context/MCP, switches Git branches, SIGTERM, cleanup.

Avoid the V1 mistake: the integration tests must exercise `memoir new`, real CLI checkout, real MCP connection, and the real Memoir store. Do not mock `memoir_checkout` and call it verified.

### 7.3 Acceptance criteria

- Unit suite deterministic, no external services.
- Integration suite passes against the pinned OpenCode/Memoir versions.
- The ambiguity test proves: capture can report succeeded/failed with an error tool part; adapter withholds sync and foreground calls; memory appears later; full restart resets.
- Branch-change-during-capture test proves the recorded branch is used, not the latest Git branch.
- No test relies on a fixed effective tool ID/prefix; tests discover the selected namespace.
- Prompt build fails on upstream anchor changes and on forbidden CLI/placeholder/tool-ID content.
- Shutdown under 10 s.
- Existing MCP config preserved.

## 8. Ordered implementation stages

### Stage 1 - Package, prompt build, store, MCP registration

**Changes**
- Replace template package metadata with `@zimniy/opencode2-memoir`.
- Add tsconfig, Biome, build scripts, test runner, `.gitignore`.
- Add `vendor/memoir` submodule pinned to v0.2.9; add patch files and `scripts/build-prompts.mjs`; finalize role-based prompt text and validation.
- Implement `state.ts`, `store.ts`, `mcp.ts`, `prompts.ts`, and a minimal `index.ts` that ensures the store and registers MCP.
- No branch/capture/agent/command yet.
- Unit tests for store/naming/prompt build.

**Prerequisite:** none.

**Acceptance**
- `npm run build` produces `dist/index.js`, declarations, generated prompts.
- Prompt patches apply cleanly; a changed anchor fails.
- Local OpenCode loads the plugin; store exists; selected hash server connects; user `memoir` server preserved.
- No runtime dependencies; no V1 runtime.
- No CI changes.

**Completion boundary:** the main agent has native Memoir tools; no automation.

### Stage 2 - Branch synchronization

**Changes**
- Implement `branch.ts` with generation/desired/provider/syncMode scaffold/sync worker/seed/observe/readiness.
- Implement CLI `checkout -b` in `store.ts`.
- Start event subscription in `index.ts` for VCS; initial get; cleanup.
- Unit tests for generation/coalescing/mode; integration for initial/ordinary/rapid/subdirectory/worktree/empty store; CLI failure.

**Prerequisite:** Stage 1.

**Acceptance**
- Branch switches become Memoir branch changes via CLI.
- Empty store and missing branch creation work.
- Rapid changes coalesce; latest wins.
- A failed checkout is logged and does not loop.
- A capture-less plugin has no wrong-branch write.
- Event loop stays responsive.

**Completion boundary:** branch synchronization works without capture.

### Stage 3 - Capture, terminal audit, agent, guard

**Changes**
- Implement `capture.ts` eligibility/exact turn/transcript/worker/audit.
- Implement `agent.ts` hidden agent/context filter.
- Implement `guard.ts`.
- Extend branch sync with `suppressed`/`unsafe` transitions and `afterCapture`.
- Unit tests for eligibility/turn/audit/state/guard; integration for exact capture, restrictions, A->B->A, branch change during capture, foreground wait, safe failure, ambiguity, interrupt, empty store.
- Test fixture slow MCP error/late write.

**Prerequisite:** Stage 2.

**Acceptance**
- One best-effort capture on success; no queue/retry/persistence.
- Exact idle only; no fallback.
- Capture branch recorded at start; A->B->A drops.
- Capture holds store lock; VCS sync waits; no interrupt.
- Terminal audit correctly sets safe/suppressed/unsafe.
- Foreground calls wait/reject; no checkout/interrupt in guard.
- Ambiguity test proves late server write after succeeded/failed; no sync/capture/foreground until restart.
- Shutdown <10 s.

**Completion boundary:** core plugin behavior complete.

### Stage 4 - Onboarding, docs, hardening

**Changes**
- Implement `memoir:onboard` command with readiness and generated prompt.
- Add README, NOTICE, usage/limitations, prompt provenance.
- Add integration for command, prompt build packaging, existing config, MCP crash, shutdown, store identity.
- Optional real-model prompt evaluation (documented separately, not CI).
- Final package dry-run (`npm pack --dry-run`) without publishing.

**Prerequisite:** Stages 1-3.

**Acceptance**
- Onboarding works in a git repo with MCP; command no skill.
- Non-Git prompt-only path documented.
- README covers install/deps/store/branch/capture/onboarding/concurrency/ambiguous termination/reload/MCP failure.
- Full unit + integration suite green.
- No CI/workflow/publish changes.

**Completion boundary:** implementation ready for review/release planning, not published.

## 9. Documented limitations

- **Ambiguous terminal Memoir work:** any Memoir tool part not `completed` sets `syncMode=unsafe`; branch sync, new captures, and foreground Memoir calls are withheld. Full OpenCode restart is the only guaranteed recovery; plugin reload is not.
- **In-flight writes can outlive terminal outcomes:** proved with a timed-out non-yielding Memoir handler; the adapter's audit is conservative.
- **A capture with no Memoir tool part is treated as safe.** The native context is the only record; an unrecorded call is not detectable.
- **Branch sync waits behind a capture:** an indefinitely running capture delays sync and foreground calls; no timeout/cancellation is added.
- **A hung `memoir` CLI** blocks the operation that awaits it; no subprocess timeout is added. The user can stop the process/restart OpenCode.
- **External/manual Memoir checkout:** not corrected until the next matching VCS event or capture; no status cache/parser.
- **Manual/external branch changes during a foreground MCP call:** not isolated; Memoir has no per-call branch lock.
- **Same store, different Git branches across locations/processes:** unsupported; no cross-location registry. Same store/same branch is best-effort with Memoir's write lock. Different stores are independent.
- **Plugin reload during active capture:** old MCP child/handler may survive; new instance may lose safety state. Not a safe boundary.
- **Local MCP process crash:** no auto-restart; tools disappear until reconnect/restart; capture/onboarding degrade.
- **Separate Git directory:** store identity uses the worktree path, so the V1 common-directory slug can differ; no compatibility layer.
- **Theoretical tool-ID collision:** a long hash name is the only mitigation; no catalog-wide resolver.
- **Prompt behavior:** patches are mechanically validated; real-model extraction/onboarding quality is not measured.
- **User-configured Memoir servers:** the adapter preserves them but coordinates only its selected hash namespace. A separate user Memoir server is outside the adapter's branch guard/sync.
- **Non-Git onboarding:** prompt-only summary; deterministic Memoir extractors are not reproduced.
- **Non-Git/unknown capture:** public session data does not expose a confirmed non-Git marker; an empty VCS state and a non-Git directory are indistinguishable. The adapter drops both conservatively. This is a limitation accepted by the implementation instructions.
- **No SessionStart/recall injection:** outside scope.
- **MCP execution timeout remains OpenCode's default (12 h);** the adapter does not add a capture timeout.
- **VCS watcher gaps:** A->B->A is detected only through observed `vcs.branch.updated` events; a missed watcher event cannot be reconstructed without polling, which is not added.
- **Start before VCS initialization:** a conversational turn that starts before the first VCS event in a Git repo is recorded as unknown and dropped; the first event does not retroactively establish the start branch. This is a narrow startup/reload window; no extra readiness cache is added.

## 10. Remaining blockers

None for implementation. The only unresolved item is behavioral prompt quality, which is explicitly outside the deterministic integration acceptance and does not block implementation. No upstream change is a prerequisite.

## 11. Implementation findings (post-plan)

These findings were discovered while implementing and refining the adapter; they do not reopen the accepted architecture.

- **MCP transform timing:** `ctx.mcp.transform` callbacks can be applied after `setup()` returns. The namespace must be reserved synchronously before the agent, context filter, and guard are registered. The implementation reserves `memoir_plugin_<storeHash>` immediately; the later transform callback resolves exact/normalized collisions with a suffix and updates `state.namespace`. The stable base tool prefix still matches the suffixed effective tool IDs. `ctx.mcp.reload()` is not a setup barrier.
- **Store creation:** `memoir new` refuses an existing store with commits. The adapter checks `<store>/.git` and skips reinitialization, matching Memoir MCP's own `ensure_store`.
- **Non-Git capture:** public `SessionInfo.location` does not expose a confirmed non-Git marker; an empty VCS state is indistinguishable from an uninitialized Git repository at capture time. The adapter drops both conservatively.
- **Dependency gating:** the implementation enables branch sync only with a registered guard and event subscription; capture requires MCP, agent, context filter, guard, event subscription, and generated prompt; onboarding requires MCP, branch sync, and the onboarding prompt.

The implementation is in the working tree; validation results are in the completion report. The plan remains the architectural reference.
