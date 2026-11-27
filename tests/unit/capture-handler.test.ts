import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Plugin } from "@opencode/plugin";
import type { snapshot } from "../../src/branch.js";
import { handleExecutionSucceeded } from "../../src/capture.js";
import { createState, type MemoirState } from "../../src/state.js";

type Session = {
  id: string;
  parentID?: string;
  agent?: string;
  location: { directory: string };
};

function makeState(
  options: {
    start?: ReturnType<typeof snapshot>;
    session?: Session;
    context?: unknown[];
    hidden?: boolean;
    mode?: string;
  } = {},
): { state: MemoirState; ctx: Plugin.Context } {
  const session: Session = options.session ?? {
    id: "ses_parent",
    location: { directory: "/tmp/project" },
    ...(options.hidden || options.mode ? { agent: "probe" } : {}),
  };
  const context = options.context ?? [
    { id: "u", type: "user", text: "question" },
    { id: "a", type: "assistant", content: [{ type: "text", text: "answer" }] },
    { id: "msg_x", type: "idle", outcome: "succeeded" },
  ];
  const ctx = {
    location: {
      directory: "/tmp/project",
      project: { id: "p", directory: "/tmp/project", canonical: "/tmp/project" },
    },
    options: {},
    session: {
      get: async () => session,
      context: async () => context,
    },
    agent: {
      get: async () => ({
        data: { hidden: options.hidden ?? false, mode: options.mode ?? "primary" },
      }),
    },
  } as unknown as Plugin.Context;

  const state = createState(ctx, "/tmp");
  state.captureEnabled = true;
  state.branchSyncEnabled = true;
  state.branch.vcsKnown = true;
  state.branch.desiredProvider = "git";
  state.branch.desiredBranch = "main";
  state.branch.generation = 1;
  state.executionStarts.set(
    "ses_parent",
    options.start ?? {
      branch: "main",
      provider: "git",
      generation: 1,
      vcsKnown: true,
    },
  );
  return { state, ctx };
}

async function run(state: MemoirState, ctx: Plugin.Context): Promise<void> {
  await handleExecutionSucceeded(ctx, state, {
    id: "evt_x",
    data: { sessionID: "ses_parent" },
  });
}

describe("capture eligibility", () => {
  it("drops an unknown/uninitialized VCS start instead of treating it as non-Git", async () => {
    const { state, ctx } = makeState({
      start: { generation: 0, vcsKnown: false },
    });
    await run(state, ctx);
    assert.equal(state.activeCapture, undefined);
  });

  it("drops detached HEAD", async () => {
    const { state, ctx } = makeState({
      start: { branch: undefined, provider: "git", generation: 1, vcsKnown: true },
    });
    await run(state, ctx);
    assert.equal(state.activeCapture, undefined);
  });

  it("drops when the generation changed (A -> B -> A)", async () => {
    const { state, ctx } = makeState();
    state.branch.generation = 3;
    await run(state, ctx);
    assert.equal(state.activeCapture, undefined);
  });

  it("drops when the exact idle is absent", async () => {
    const { state, ctx } = makeState({
      context: [
        { id: "u", type: "user", text: "q" },
        { id: "a", type: "assistant", content: [{ type: "text", text: "a" }] },
        { id: "msg_other", type: "idle", outcome: "succeeded" },
      ],
    });
    await run(state, ctx);
    assert.equal(state.activeCapture, undefined);
  });

  it("drops hidden, subagent, and subordinate sessions", async () => {
    for (const options of [
      { hidden: true },
      { mode: "subagent" },
      {
        session: {
          id: "ses_parent",
          parentID: "ses_root",
          location: { directory: "/tmp/project" },
        },
      },
    ]) {
      const { state, ctx } = makeState(options);
      await run(state, ctx);
      assert.equal(state.activeCapture, undefined);
    }
  });

  it("drops another location", async () => {
    const { state, ctx } = makeState({
      session: { id: "ses_parent", location: { directory: "/tmp/other" } },
    });
    await run(state, ctx);
    assert.equal(state.activeCapture, undefined);
  });

  it("drops when auto-save is disabled", async () => {
    const previous = process.env.MEMOIR_AUTO_SAVE;
    process.env.MEMOIR_AUTO_SAVE = "0";
    try {
      const { state, ctx } = makeState();
      await run(state, ctx);
      assert.equal(state.activeCapture, undefined);
    } finally {
      if (previous === undefined) delete process.env.MEMOIR_AUTO_SAVE;
      else process.env.MEMOIR_AUTO_SAVE = previous;
    }
  });
});
