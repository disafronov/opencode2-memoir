import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Plugin } from "@opencode/plugin";
import { handleExecutionSucceeded } from "../../src/capture.js";
import { createState, type MemoirState } from "../../src/state.js";
import { type FakeMemoir, installFakeMemoir } from "./fake-cli.js";

type CreateInput = { agent?: string; title?: string; model?: unknown };

let fakeMemoir: FakeMemoir;

before(async () => {
  fakeMemoir = await installFakeMemoir();
});

after(async () => {
  await fakeMemoir.restore();
});

type Harness = {
  ctx: Plugin.Context;
  state: MemoirState;
  createInputs: CreateInput[];
  removed: Promise<void>;
};

function makeHarness(sessionModel?: { id: string; providerID: string; variant?: string }): Harness {
  let resolveRemoved!: () => void;
  const removed = new Promise<void>((resolve) => {
    resolveRemoved = resolve;
  });
  const createInputs: CreateInput[] = [];
  const parent = {
    id: "ses_parent",
    location: { directory: "/tmp/project" },
    ...(sessionModel ? { model: sessionModel } : {}),
  };
  const captureSession = {
    id: "ses_capture",
    outcome: "succeeded",
    location: { directory: "/tmp/project" },
  };
  const context = [
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
      get: async ({ sessionID }: { sessionID: string }) =>
        sessionID === "ses_parent" ? parent : captureSession,
      context: async () => context,
      create: async (input: CreateInput) => {
        createInputs.push(input);
        return captureSession;
      },
      prompt: async () => undefined,
      wait: async () => undefined,
      remove: async () => resolveRemoved(),
    },
  } as unknown as Plugin.Context;

  const state = createState(ctx, process.cwd());
  state.captureEnabled = true;
  state.branchSyncEnabled = true;
  state.branch.vcsKnown = true;
  state.branch.desiredProvider = "git";
  state.branch.desiredBranch = "main";
  state.branch.generation = 1;
  state.executionStarts.set("ses_parent", {
    branch: "main",
    provider: "git",
    generation: 1,
    vcsKnown: true,
  });

  return { ctx, state, createInputs, removed };
}

async function run(h: Harness): Promise<void> {
  await handleExecutionSucceeded(h.ctx, h.state, {
    id: "evt_x",
    data: { sessionID: "ses_parent" },
  });
  await h.removed;
}

describe("capture session model", () => {
  it("inherits the active session model", async () => {
    const sessionModel = { id: "session-model", providerID: "session", variant: "xhigh" };
    const h = makeHarness(sessionModel);
    await run(h);
    assert.deepEqual(h.createInputs[0], {
      title: "memoir:capture",
      agent: "memoir",
      model: sessionModel,
    });
  });

  it("omits the model when the session has none", async () => {
    const h = makeHarness();
    await run(h);
    assert.deepEqual(h.createInputs[0], {
      title: "memoir:capture",
      agent: "memoir",
    });
  });

  it("prefers MEMOIR_AGENT_MODEL over the active session model", async () => {
    const previous = process.env.MEMOIR_AGENT_MODEL;
    process.env.MEMOIR_AGENT_MODEL = "override/fast:low";
    try {
      const h = makeHarness({ id: "session-model", providerID: "session" });
      await run(h);
      assert.deepEqual(h.createInputs[0].model, {
        id: "fast",
        providerID: "override",
        variant: "low",
      });
    } finally {
      if (previous === undefined) delete process.env.MEMOIR_AGENT_MODEL;
      else process.env.MEMOIR_AGENT_MODEL = previous;
    }
  });
});
