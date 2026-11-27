import type { Plugin } from "@opencode/plugin";

/** How the adapter treats branch changes and the capture that produced them. */
export type SyncMode = "ok" | "suppressed" | "unsafe";

/** The Git branch/provider observed when a turn starts, plus the event generation. */
export type BranchSnapshot = {
  branch?: string;
  provider?: string;
  generation: number;
  vcsKnown: boolean;
};

/** The one best-effort capture session currently owned by the adapter. */
export type ActiveCapture = BranchSnapshot & {
  captureSessionID?: string;
  done: Promise<void>;
};

/** Branch synchronization state, scoped to one plugin/location instance. */
export type BranchState = {
  generation: number;
  desiredBranch?: string;
  desiredProvider?: string;
  vcsKnown: boolean;
  syncMode: SyncMode;
  syncWanted: boolean;
  syncPromise?: Promise<void>;
  syncError?: Error;
};

/** The complete adapter state. Everything is in-memory and per plugin instance. */
export type MemoirState = {
  ctx: Plugin.Context;
  storePath: string;
  mcpReady: boolean;
  onReady?: () => void;
  captureEnabled: boolean;
  branchSyncEnabled: boolean;
  onboardEnabled: boolean;
  activeCapture?: ActiveCapture;
  executionStarts: Map<string, BranchSnapshot>;
  branch: BranchState;
  lock: Promise<void>;
  shuttingDown: boolean;
};

/** Create the one state object for a plugin setup. */
export function createState(ctx: Plugin.Context, storePath: string): MemoirState {
  return {
    ctx,
    storePath,
    mcpReady: false,
    captureEnabled: false,
    branchSyncEnabled: false,
    onboardEnabled: false,
    executionStarts: new Map(),
    branch: {
      generation: 0,
      vcsKnown: false,
      syncMode: "ok",
      syncWanted: false,
    },
    lock: Promise.resolve(),
    shuttingDown: false,
  };
}

/** Serialize adapter-owned branch-changing work without a queue implementation. */
export function withStoreLock<T>(state: MemoirState, work: () => Promise<T>): Promise<T> {
  const run = state.lock.then(work, work);
  state.lock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** A promise plus its resolver, used for the active-capture barrier. */
export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Compute dependent capabilities from successful native registrations. */
export function capabilities(input: {
  mcpReady: boolean;
  agentReady: boolean;
  contextReady: boolean;
  guardReady: boolean;
  eventReady: boolean;
  capturePromptReady: boolean;
  onboardPromptReady: boolean;
}): { branchSyncEnabled: boolean; captureEnabled: boolean; onboardEnabled: boolean } {
  const branchSyncEnabled = input.guardReady && input.eventReady;
  return {
    branchSyncEnabled,
    captureEnabled:
      input.mcpReady &&
      input.agentReady &&
      input.contextReady &&
      input.guardReady &&
      input.eventReady &&
      input.capturePromptReady,
    onboardEnabled: input.mcpReady && branchSyncEnabled && input.onboardPromptReady,
  };
}
