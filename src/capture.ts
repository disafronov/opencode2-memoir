import type { Plugin } from "@opencode/plugin";
import { afterCapture, snapshot } from "./branch.js";
import { MEMOIR_TOOL_PREFIX } from "./mcp.js";
import type { ActiveCapture, MemoirState } from "./state.js";
import { deferred, withStoreLock } from "./state.js";
import { checkoutBranch } from "./store.js";

type ContextPart = {
  type?: string;
  text?: string;
  name?: string;
  state?: { status?: string };
};

type ContextMessage = {
  id?: string;
  type?: string;
  text?: string;
  content?: ContextPart[];
};

type SessionInfo = Awaited<ReturnType<Plugin.Context["session"]["get"]>>;

/** Execution start event is enough for branch association. */
export function recordExecutionStart(
  state: MemoirState,
  event: { data: { sessionID: string } },
): void {
  state.executionStarts.set(event.data.sessionID, snapshot(state));
}

export function clearExecutionStart(state: MemoirState, sessionID: string): void {
  state.executionStarts.delete(sessionID);
}

function assistantText(message: ContextMessage): string {
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("\n");
}

/**
 * Extract the exact completed turn using the idle message ID derived from the
 * execution event ID. No fallback to a "most recent" idle is permitted.
 */
export function extractTurn(messages: ContextMessage[], idleID: string): string | undefined {
  let idleIndex = -1;
  for (let index = 0; index < messages.length; index++) {
    if (messages[index]?.type === "idle" && messages[index]?.id === idleID) {
      idleIndex = index;
      break;
    }
  }
  if (idleIndex < 0) return undefined;

  let previousIdle = -1;
  for (let index = idleIndex - 1; index >= 0; index--) {
    if (messages[index]?.type === "idle") {
      previousIdle = index;
      break;
    }
  }

  const turn = messages.slice(previousIdle + 1, idleIndex);
  let assistantIndex = -1;
  for (let index = turn.length - 1; index >= 0; index--) {
    const message = turn[index];
    if (message?.type === "assistant" && assistantText(message).trim()) {
      assistantIndex = index;
      break;
    }
  }
  if (assistantIndex < 0) return undefined;

  let userIndex = -1;
  for (let index = assistantIndex - 1; index >= 0; index--) {
    const message = turn[index];
    if (message?.type === "user" && typeof message.text === "string" && message.text.trim()) {
      userIndex = index;
      break;
    }
  }
  if (userIndex < 0) return undefined;

  const user = turn[userIndex]?.text?.trim() ?? "";
  const assistant = assistantText(turn[assistantIndex] ?? {}).trim();
  if (!user || !assistant) return undefined;
  return `[Human]\n${user}\n\n[Assistant]\n${assistant}`;
}

/**
 * Inspect the native capture context. Any Memoir tool part that did not reach
 * `completed` is ambiguous; a malformed assistant content is also ambiguous.
 */
export function auditMemoirToolParts(messages: unknown[]): boolean {
  for (const value of messages) {
    const message = value as ContextMessage;
    if (message?.type !== "assistant") continue;
    if (!Array.isArray(message.content)) return true;
    for (const part of message.content) {
      if (part?.type !== "tool") continue;
      if (typeof part.name !== "string" || !part.name.startsWith(MEMOIR_TOOL_PREFIX)) continue;
      if (part.state?.status !== "completed") return true;
    }
  }
  return false;
}

function sameLocation(left: SessionInfo["location"], right: Plugin.Context["location"]): boolean {
  // SessionInfo.location is the public Location.Ref; workspaceID is not exposed.
  return left.directory === right.directory;
}

function sameCaptureBranch(state: MemoirState, capture: ActiveCapture): boolean {
  const now = snapshot(state);
  return (
    now.vcsKnown &&
    now.provider === "git" &&
    now.branch !== undefined &&
    now.branch === capture.branch &&
    now.provider === capture.provider &&
    now.generation === capture.generation
  );
}

async function eligibleSession(
  ctx: Plugin.Context,
  sessionID: string,
): Promise<SessionInfo | undefined> {
  const session = await ctx.session.get({ sessionID }).catch(() => undefined);
  if (!session) return undefined;
  if (!sameLocation(session.location, ctx.location)) return undefined;
  if (session.parentID) return undefined;
  if (session.agent === "memoir") return undefined;

  if (session.agent) {
    const agent = await ctx.agent.get({ agentID: session.agent }).catch(() => undefined);
    if (!agent) return undefined;
    if (agent.data.hidden || agent.data.mode === "subagent") return undefined;
  }

  return session;
}

/** Handle one successful execution. Eligibility and claim are separated by awaits. */
export async function handleExecutionSucceeded(
  ctx: Plugin.Context,
  state: MemoirState,
  event: { id: string; data: { sessionID: string } },
): Promise<void> {
  const sessionID = event.data.sessionID;
  const start = state.executionStarts.get(sessionID);
  state.executionStarts.delete(sessionID);
  if (!start) return;

  if (!state.captureEnabled) return;
  if (process.env.MEMOIR_AUTO_SAVE === "0") return;
  if (state.branch.syncMode !== "ok" || state.shuttingDown || state.activeCapture) return;

  const session = await eligibleSession(ctx, sessionID);
  if (!session) return;

  const context = await ctx.session.context({ sessionID }).catch(() => undefined);
  if (!context) return;

  const idleID = event.id.replace(/^evt_/, "msg_");
  const transcript = extractTurn(context as ContextMessage[], idleID);
  if (!transcript) return;

  const now = snapshot(state);
  if (!start.vcsKnown || !now.vcsKnown) return;
  if (start.provider !== "git" || now.provider !== "git") return;
  if (!start.branch) return;
  if (
    start.generation !== now.generation ||
    start.branch !== now.branch ||
    start.provider !== now.provider
  ) {
    return;
  }

  // No awaits between this check and the active-capture claim.
  if (state.branch.syncMode !== "ok" || state.shuttingDown || state.activeCapture) return;
  const barrier = deferred();
  const capture: ActiveCapture = {
    ...start,
    done: barrier.promise,
  };
  state.activeCapture = capture;

  void runCapture(ctx, state, capture, transcript)
    .catch((error) => console.error("[memoir] capture failed", error))
    .finally(() => {
      if (state.activeCapture === capture) state.activeCapture = undefined;
      barrier.resolve();
    });
}

async function runCapture(
  ctx: Plugin.Context,
  state: MemoirState,
  capture: ActiveCapture,
  transcript: string,
): Promise<void> {
  let sessionID: string | undefined;
  let outcome: string | undefined;
  let ambiguous = false;
  let attempted = false;

  try {
    await withStoreLock(state, async () => {
      if (!state.captureEnabled || !state.branchSyncEnabled) return;
      if (state.shuttingDown || state.branch.syncMode !== "ok") return;
      if (state.activeCapture !== capture) return;
      if (!sameCaptureBranch(state, capture)) return;

      attempted = true;
      if (capture.branch) {
        const checkout = await checkoutBranch(state.storePath, capture.branch);
        if (checkout.code !== 0) return;
      }

      const created = await ctx.session.create({ title: "memoir:capture", agent: "memoir" });
      sessionID = created.id;
      capture.captureSessionID = created.id;

      await ctx.session.prompt({
        sessionID: created.id,
        text: transcript,
        delivery: "queue",
      });
      await ctx.session.wait({ sessionID: created.id });

      const info = await ctx.session.get({ sessionID: created.id });
      outcome = info.outcome;
      if (outcome !== "succeeded" && outcome !== "failed" && outcome !== "interrupted") {
        ambiguous = true;
      }

      const context = await ctx.session.context({ sessionID: created.id });
      if (auditMemoirToolParts(context)) ambiguous = true;
    });
  } catch (error) {
    console.error("[memoir] capture worker error", error);
    if (sessionID) ambiguous = true;
  } finally {
    if (sessionID) {
      afterCapture(state, outcome, ambiguous);
      await ctx.session.remove({ sessionID }).catch((error) => {
        console.error("[memoir] failed to remove capture session", error);
      });
    } else if (attempted) {
      // Checkout failure or revalidation failure: no Memoir call was made.
      afterCapture(state, "failed", false);
    }
  }
}
