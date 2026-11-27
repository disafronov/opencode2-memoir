import type { Plugin } from "@opencode/plugin";
import { Tool } from "@opencode/plugin/effect";
import type { BranchSnapshot, MemoirState } from "./state.js";
import { withStoreLock } from "./state.js";
import { checkoutBranch } from "./store.js";

type VcsBranchEvent = {
  type: "vcs.branch.updated";
  location?: { directory: string; workspaceID?: string };
  data: { branch?: string };
};

type VcsInfo = {
  data: {
    provider?: string;
    branch?: { current?: string };
  };
};

/** Compare a VCS event location with this plugin instance's location. */
function sameLocation(event: VcsBranchEvent, ctx: Plugin.Context): boolean {
  const location = event.location;
  if (!location || location.directory !== ctx.location.directory) return false;
  if (location.workspaceID && ctx.location.workspaceID) {
    return location.workspaceID === ctx.location.workspaceID;
  }
  return true;
}

/** Snapshot the branch association used by an execution start. */
export function snapshot(state: MemoirState): BranchSnapshot {
  return {
    branch: state.branch.desiredBranch,
    provider: state.branch.desiredProvider,
    generation: state.branch.generation,
    vcsKnown: state.branch.vcsKnown,
  };
}

/** Seed the initial VCS state without treating an empty result as detached/non-Git. */
export function seed(state: MemoirState, vcs: VcsInfo): void {
  if (state.branch.generation !== 0) return;
  const provider = vcs.data.provider;
  const branch = vcs.data.branch?.current;

  if (provider === "git") {
    state.branch.vcsKnown = true;
    state.branch.desiredProvider = "git";
    state.branch.desiredBranch = branch;
    state.branch.generation = 1;
    if (branch) requestSync(state);
    return;
  }

  if (provider) {
    state.branch.vcsKnown = true;
    state.branch.desiredProvider = provider;
    state.branch.desiredBranch = branch;
    state.branch.generation = 1;
    return;
  }

  if (branch !== undefined) {
    state.branch.vcsKnown = true;
    state.branch.desiredProvider = "git";
    state.branch.desiredBranch = branch;
    state.branch.generation = 1;
    requestSync(state);
  }
  // No provider and no branch: unknown. It may be non-Git or VCS not initialized.
  // Capture is dropped until a native event/seed identifies the VCS.
}

/** Apply a real VCS branch event. */
export function observeVcs(state: MemoirState, event: VcsBranchEvent): void {
  if (!sameLocation(event, state.ctx)) return;

  state.branch.vcsKnown = true;
  state.branch.desiredProvider ??= "git";
  state.branch.generation++;
  state.branch.desiredBranch = event.data.branch;

  if (state.branch.syncMode === "suppressed") state.branch.syncMode = "ok";
  if (state.branch.syncMode === "ok") requestSync(state);
}

function canSync(state: MemoirState): boolean {
  return state.branchSyncEnabled && !state.shuttingDown && state.branch.syncMode === "ok";
}

/**
 * Request a coalesced branch checkout.
 *
 * Pending requests survive an active capture: the worker waits on the capture
 * barrier without consuming `syncWanted`.
 */
export function requestSync(state: MemoirState): void {
  if (!canSync(state)) return;
  if (!state.branch.desiredBranch || state.branch.desiredProvider !== "git") {
    state.branch.syncWanted = false;
    return;
  }

  state.branch.syncWanted = true;
  if (state.branch.syncPromise) return;

  state.branch.syncError = undefined;
  state.branch.syncPromise = runSync(state).finally(() => {
    state.branch.syncPromise = undefined;
    if (state.branch.syncWanted && canSync(state)) requestSync(state);
  });
}

async function runSync(state: MemoirState): Promise<void> {
  try {
    while (state.branch.syncWanted) {
      if (!canSync(state)) return;

      // Do not clear syncWanted before waiting. A VCS event during the wait
      // must survive; a request is consumed only by a successful checkout or
      // an explicit abandon below.
      if (state.activeCapture) {
        await state.activeCapture.done;
        continue;
      }

      const targetGeneration = state.branch.generation;
      const targetBranch = state.branch.desiredBranch;
      if (targetBranch === undefined) {
        state.branch.syncWanted = false;
        return;
      }
      if (state.branch.desiredProvider !== "git") {
        state.branch.syncWanted = false;
        return;
      }

      const outcome = await withStoreLock(state, async () => {
        if (!canSync(state)) return "stop" as const;
        if (state.activeCapture) return "retry" as const;
        if (
          state.branch.generation !== targetGeneration ||
          state.branch.desiredBranch !== targetBranch
        ) {
          return "retry" as const;
        }

        const result = await checkoutBranch(state.storePath, targetBranch);
        if (result.code !== 0) {
          state.branch.syncError = new Error(
            `memoir checkout -b ${targetBranch} failed: ${result.stderr || result.stdout}`,
          );
          return "failed" as const;
        }
        return "ok" as const;
      });

      if (outcome === "stop") return;
      if (outcome === "retry") continue;
      if (outcome === "failed") {
        // A VCS event that arrived while the failed checkout was running is a
        // new request for a newer generation. It is not an automatic retry of
        // the same target.
        if (
          state.branch.generation !== targetGeneration ||
          state.branch.desiredBranch !== targetBranch
        ) {
          state.branch.syncError = undefined;
          continue;
        }
        state.branch.syncWanted = false;
        return;
      }

      if (
        state.branch.generation === targetGeneration &&
        state.branch.desiredBranch === targetBranch
      ) {
        state.branch.syncWanted = false;
      }
    }
  } catch (error) {
    state.branch.syncError = error instanceof Error ? error : new Error(String(error));
    state.branch.syncWanted = false;
  }
}

/** Wait until no capture or pending checkout is holding branch-changing work. */
export async function awaitReady(state: MemoirState): Promise<void> {
  for (;;) {
    if (!state.branchSyncEnabled || state.shuttingDown || state.branch.syncMode !== "ok") {
      throw new Error(
        state.branch.syncMode === "ok"
          ? "Memoir branch synchronization is not available"
          : `Memoir branch synchronization is ${state.branch.syncMode}`,
      );
    }
    if (state.activeCapture) {
      await state.activeCapture.done;
      continue;
    }
    if (state.branch.syncError) throw state.branch.syncError;
    if (state.branch.syncPromise) {
      await state.branch.syncPromise;
      continue;
    }
    if (state.branch.syncWanted) {
      requestSync(state);
      continue;
    }
    return;
  }
}

/**
 * Record the terminal audit result before the capture releases the barrier.
 *
 * A safe successful/failed capture resumes synchronization only when a VCS
 * event actually queued a pending request during the capture. It never creates
 * a synthetic request merely because the capture completed.
 */
export function afterCapture(
  state: MemoirState,
  outcome: string | undefined,
  ambiguous: boolean,
): void {
  if (ambiguous) {
    state.branch.syncMode = "unsafe";
    state.branch.syncWanted = false;
    console.error("[memoir] ambiguous Memoir tool termination; branch synchronization is unsafe");
    return;
  }
  if (outcome === "interrupted") {
    state.branch.syncMode = "suppressed";
    state.branch.syncWanted = false;
    return;
  }
  if (state.branch.syncWanted) requestSync(state);
}

/** Register the wait-only guard for foreground Memoir tools. */
export async function registerMemoirToolGuard(
  ctx: Plugin.Context,
  state: MemoirState,
): Promise<{ dispose: () => Promise<void> }> {
  return ctx.tool.hook("execute.before", async (event) => {
    if (!state.mcpRegistered || !state.namespace) return;
    if (event.info?.options?.namespace !== state.namespace) return;
    if (state.activeCapture?.captureSessionID === event.sessionID) return;

    try {
      await awaitReady(state);
    } catch (error) {
      throw new Tool.Error({
        message: `Memoir branch synchronization is unavailable: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  });
}
