import { Plugin } from "@opencode/plugin";
import {
  registerCaptureAgent,
  registerCaptureToolFilter,
  registerOnboardCommand,
} from "./agent.js";
import { awaitReady, observeVcs, registerMemoirToolGuard, requestSync, seed } from "./branch.js";
import { clearExecutionStart, handleExecutionSucceeded, recordExecutionStart } from "./capture.js";
import { registerMemoirMcp } from "./mcp.js";
import { loadCapturePrompt, loadOnboardPrompt } from "./prompts.js";
import { capabilities, createState, type MemoirState } from "./state.js";
import { ensureStore, hashStore, resolveStore, safeRealpath } from "./store.js";

type Registration = { dispose: () => Promise<void> };

const types = [
  "vcs.branch.updated",
  "session.execution.started",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
] as const;

function log(...args: unknown[]): void {
  console.error("[memoir]", ...args);
}

function noopCleanup(): void {}

export default Plugin.define({
  id: "opencode2-memoir",
  async setup(ctx): Promise<() => Promise<void> | void> {
    let state: MemoirState;
    try {
      const storePath = resolveStore(ctx);
      const canonicalStore = await ensureStore(storePath);
      state = createState(ctx, canonicalStore, hashStore(safeRealpath(canonicalStore)));
    } catch (error) {
      log("store setup failed; plugin is inert", error);
      return noopCleanup;
    }

    const abort = new AbortController();
    const registrations: Registration[] = [];
    let mcpRegistrationSucceeded = false;
    let guardReady = false;
    let agentReady = false;
    let contextReady = false;
    let eventReady = false;
    let commandReady = false;
    let capturePrompt: string | undefined;
    let onboardPrompt: string | undefined;

    const refreshCapabilities = () => {
      if (state.shuttingDown) return;
      const caps = capabilities({
        mcpReady: state.mcpReady,
        agentReady,
        contextReady,
        guardReady,
        eventReady,
        capturePromptReady: Boolean(capturePrompt),
        onboardPromptReady: Boolean(onboardPrompt),
      });
      state.branchSyncEnabled = caps.branchSyncEnabled;
      state.captureEnabled = caps.captureEnabled;
      state.onboardEnabled = caps.onboardEnabled && commandReady;
    };
    state.onReady = refreshCapabilities;

    try {
      capturePrompt = loadCapturePrompt();
    } catch (error) {
      log("capture prompt is unavailable; capture disabled", error);
    }
    try {
      onboardPrompt = loadOnboardPrompt();
    } catch (error) {
      log("onboarding prompt is unavailable; onboarding disabled", error);
    }

    try {
      await registerMemoirMcp(ctx, state);
      mcpRegistrationSucceeded = Boolean(state.serverName && state.namespace && state.toolPrefix);
      if (!mcpRegistrationSucceeded) log("MCP registration did not select a namespace");
    } catch (error) {
      state.mcpRegistered = false;
      state.mcpReady = false;
      log("MCP registration failed; capture/onboarding disabled", error);
    }

    try {
      registrations.push(await registerMemoirToolGuard(ctx, state));
      guardReady = true;
    } catch (error) {
      log("foreground Memoir guard failed; automatic branch changes disabled", error);
    }

    if (mcpRegistrationSucceeded && state.toolPrefix && capturePrompt) {
      try {
        await registerCaptureAgent(ctx, state, capturePrompt);
        agentReady = true;
      } catch (error) {
        log("capture agent registration failed; capture disabled", error);
      }
    }

    if (mcpRegistrationSucceeded && agentReady) {
      try {
        registrations.push(await registerCaptureToolFilter(ctx, state));
        contextReady = true;
      } catch (error) {
        log("capture tool filter registration failed; capture disabled", error);
      }
    }

    let events:
      | AsyncIterable<{
          type: string;
          id?: string;
          location?: { directory: string; workspaceID?: string };
          data?: unknown;
        }>
      | undefined;
    try {
      events = ctx.event.subscribe({
        signal: abort.signal,
        types: [...types],
      }) as typeof events;
      eventReady = true;
    } catch (error) {
      log("event subscription failed; automatic behavior disabled", error);
    }

    // Branch sync may start before MCP discovery; capture and onboarding wait
    // for the MCP transform to confirm the actual selected namespace.
    refreshCapabilities();

    if (mcpRegistrationSucceeded && state.branchSyncEnabled && onboardPrompt) {
      try {
        registrations.push(
          await registerOnboardCommand(ctx, state, onboardPrompt, () => awaitReady(state)),
        );
        commandReady = true;
      } catch (error) {
        log("onboarding command registration failed", error);
      }
    }
    refreshCapabilities();

    if (eventReady && events) {
      void (async () => {
        for await (const event of events) {
          if (event.type === "vcs.branch.updated") {
            observeVcs(state, {
              type: "vcs.branch.updated",
              location: event.location,
              data: (event.data as { branch?: string } | undefined) ?? {},
            });
            continue;
          }

          const sessionID = (event.data as { sessionID?: string } | undefined)?.sessionID;
          if (!sessionID) continue;

          if (event.type === "session.execution.started") {
            recordExecutionStart(state, { data: { sessionID } });
            continue;
          }
          if (event.type === "session.execution.succeeded") {
            void handleExecutionSucceeded(ctx, state, {
              id: event.id ?? "",
              data: { sessionID },
            }).catch((error) => log("capture handler failed", error));
            continue;
          }
          clearExecutionStart(state, sessionID);
        }
      })().catch((error) => log("event loop stopped", error));
    }

    try {
      const vcs = await ctx.vcs.get();
      seed(state, vcs);
      if (state.branchSyncEnabled) requestSync(state);
    } catch (error) {
      log("initial VCS read failed; waiting for events", error);
    }

    return async () => {
      state.shuttingDown = true;
      state.captureEnabled = false;
      state.branchSyncEnabled = false;
      state.onboardEnabled = false;
      state.onReady = undefined;
      abort.abort();
      for (const registration of registrations) {
        try {
          await registration.dispose();
        } catch (error) {
          log("hook cleanup failed", error);
        }
      }
    };
  },
});
