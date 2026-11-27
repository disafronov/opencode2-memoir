# @zimniy/opencode2-memoir

Minimal Memoir integration for OpenCode V2. The plugin connects OpenCode's
native MCP, VCS, session, and hook APIs to Memoir's native CLI and MCP server.

## Requirements

- OpenCode V2.4.1 or a compatible V2 release.
- `memoir-mcp` and the `memoir` CLI on `PATH`, both provided by:

  ```sh
  uv tool install --python 3.13 "memoir-ai[mcp]==0.2.9"
  ```

- Node.js 24 for building and running the plugin's local checks.

## Install

Add the package to the OpenCode configuration:

```jsonc
{
  "plugins": ["@zimniy/opencode2-memoir"]
}
```

A store override can be supplied in the plugin entry:

```jsonc
{
  "plugins": [
    {
      "package": "@zimniy/opencode2-memoir",
      "options": { "store": "/path/to/memoir-store" }
    }
  ]
}
```

For local development, point `plugins` at this repository directory. The
package must be built first (`npm run build`).

## Store resolution

The store is resolved in this order:

1. `options.store` in the plugin entry;
2. `MEMOIR_STORE`;
3. `~/.memoir/<slug>` using the canonical OpenCode project directory.

The plugin creates a missing store with `memoir new`. An existing store whose
`.git` directory is present is reused; `memoir new` is not called again because
Memoir refuses to reinitialize a store with commits.

The local MCP server is registered under the exact name `memoir`. The plugin is
the authoritative owner of `memoir` while installed: on every
`ctx.mcp.transform` invocation, including reloads, it unconditionally sets the
`memoir` server to `memoir-mcp --store <store>`, overriding any user-defined
`memoir` configuration in memory. User configuration files are not modified,
unrelated MCP servers are untouched, and when the plugin is absent the original
user-defined configuration applies normally. The fixed namespace `memoir`
yields the effective tool prefix `memoir_`.

## Branch synchronization

The adapter listens to OpenCode `vcs.branch.updated` events and mirrors the
active Git branch into the Memoir store with:

```sh
memoir checkout -b <git-branch>
```

A new Memoir branch starts at the current Memoir HEAD. The adapter does not
define a different branching policy.

Branch synchronization waits for an active capture instead of interrupting it.
An in-flight Memoir MCP operation cannot be safely cancelled by interrupting
the OpenCode session; waiting is the only verified safe behavior.

Manual `memoir checkout` calls, from the main agent or an external process, are
outside adapter control. They are not actively corrected until a later branch
event or capture.

## Automatic capture

Completed root, user-facing turns are captured best-effort after
`session.execution.succeeded`. The adapter:

- identifies the exact turn from the event ID and the corresponding idle message;
- extracts only user and assistant text;
- creates a hidden `memoir` session;
- runs the adapted Memoir capture prompt;
- waits for completion and removes the temporary session.

There is no capture queue, retry, timeout, transcript persistence, or recovery.
At most one capture is active. Capture is skipped for unknown VCS state, detached
HEAD, subordinate sessions, hidden agents, and non-Git projects. Public OpenCode
session data does not provide a reliable confirmed non-Git signal, so the
adapter takes the conservative path and drops those captures.

Set `MEMOIR_AUTO_SAVE=0` to disable automatic capture. Branch synchronization
and `/memoir:onboard` remain available.

### Capture model

The hidden capture session inherits the model active in the completed session,
including its variant. Set `MEMOIR_AGENT_MODEL=provider/model` (optionally
`provider/model:variant`) to override that choice for capture only. A malformed
override is reported and ignored, and the active session model is used instead.
When neither source provides a model, OpenCode's native default is left in
place. The hidden `memoir` agent itself has no model override.

## Onboarding

Run the native command:

```text
/memoir:onboard
```

The command executes the adapted Memoir `codebase:onboard` procedure in the
current session. In non-Git folders it uses a prompt-only `project:onboard`
summary; deterministic upstream extractors are intentionally not reproduced.
No Memoir skills are registered.

## Branch safety and ambiguous termination

A capture holds the adapter store lock across the MCP execution and `wait`.
Branch synchronization and foreground Memoir tools wait for it. Foreground
Memoir tool calls are guarded by a wait-only `execute.before` hook; the hook
does not check out branches or interrupt captures.

After capture, the terminal Memoir tool parts are audited:

- all completed, or no Memoir parts: safe for the documented scope;
- any error, running, streaming, or malformed part: ambiguous.

Safe successful/failed captures allow a genuinely pending branch sync. A safe
interrupted capture suppresses immediate sync; a later matching VCS event may
retry. Ambiguous termination sets the instance to unsafe: branch sync, new
captures, and foreground Memoir calls are withheld for the lifetime of the
plugin instance.

A full OpenCode process restart is the only guaranteed recovery from an
ambiguous Memoir MCP operation. Plugin reload is not a recovery boundary: an
old MCP child or in-flight handler can survive it.

## Limitations

- A permanently hung capture can delay branch synchronization and foreground
  Memoir calls. The adapter deliberately does not add cancellation timeouts.
- Multiple OpenCode locations or processes may use different stores
  independently. Using the same store on different Git branches concurrently is
  unsupported.
- A local `memoir-mcp` process crash is not automatically restarted by the
  public plugin API. Native Memoir tools are unavailable until the user reconnects
  or restarts OpenCode.
- A missed native VCS watcher event cannot be reconstructed; the adapter does
  not poll or run a separate Git watcher.
- A turn that starts before the first VCS event in a Git repository can be
  treated as unknown and dropped.
- An MCP operation may continue server-side after a session reports success,
  failure, or interruption. The terminal tool-part audit is the documented
  native signal; it does not prove the Python handler has exited.
- The plugin requires both the Memoir CLI and `memoir-mcp`; `memoir-mcp` alone
  is insufficient for branch synchronization.

## Development

```sh
git submodule update --init --recursive
npm install
npm run lint
npm run typecheck
npm run build
npm test
OPENCODE_BIN=/path/to/opencode npm run test:integration
```

Unit tests cover adapter logic. Integration tests use real OpenCode V2.4.1 and
Memoir 0.2.9, a deterministic local model, real store initialization, real CLI
checkout, and real MCP execution. The delayed MCP fixture verifies the
late-write ambiguity contract.

## Prompt provenance

The capture and onboarding prompts are generated from Memoir v0.2.9 at commit
`0b92609461d8d3ebeacec55ad26d3250b86558e8` through the patches in `patches/`.
Memoir is Apache-2.0 licensed. See `NOTICE.md`. The generated prompts are included
in `dist/prompts/`; the `vendor/memoir` submodule is build-time only.

<!-- refactor: validate publishing -->
