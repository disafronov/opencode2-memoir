import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Plugin } from "@opencode/plugin";
import { Tool } from "@opencode/plugin/effect";
import {
  afterCapture,
  awaitReady,
  observeVcs,
  registerMemoirToolGuard,
  requestSync,
  seed,
  snapshot,
} from "../../src/branch.js";
import { createState, deferred, type MemoirState } from "../../src/state.js";
import { type FakeMemoir, installFakeMemoir } from "./fake-cli.js";

let fake: FakeMemoir | undefined;
afterEach(async () => {
  await fake?.restore();
  fake = undefined;
});

function testState(): MemoirState {
  const ctx = {
    location: {
      directory: "/tmp/project",
      project: { id: "p", directory: "/tmp/project", canonical: "/tmp/project" },
    },
    options: {},
  } as unknown as Plugin.Context;
  const state = createState(ctx, "/tmp");
  state.branchSyncEnabled = true;
  state.branch.vcsKnown = true;
  state.branch.desiredProvider = "git";
  state.branch.desiredBranch = "main";
  state.branch.generation = 1;
  return state;
}

function setBranch(state: MemoirState, branch: string, generation: number): void {
  state.branch.desiredBranch = branch;
  state.branch.generation = generation;
  state.branch.vcsKnown = true;
  state.branch.desiredProvider = "git";
}

async function wait(ms = 25): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeout = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await predicate()) return;
    await wait(10);
  }
  throw new Error("condition was not reached");
}

async function checkoutCount(fake: FakeMemoir): Promise<number> {
  return (await fake.calls()).filter((line) => line === "checkout").length;
}

describe("branch generation", () => {
  it("does not treat an uninitialized/empty VCS as known non-Git", () => {
    const state = testState();
    state.branch.vcsKnown = false;
    state.branch.generation = 0;
    delete state.branch.desiredBranch;
    delete state.branch.desiredProvider;

    seed(state, { data: {} });
    assert.equal(snapshot(state).vcsKnown, false);
    assert.equal(state.branch.generation, 0);
  });

  it("keeps Git confirmed and detects A -> B -> A by generation", () => {
    const state = testState();
    state.branch.generation = 0;
    seed(state, { data: { provider: "git", branch: { current: "A" } } });
    assert.equal(state.branch.generation, 1);
    observeVcs(state, {
      type: "vcs.branch.updated",
      location: { directory: "/tmp/project" },
      data: { branch: "B" },
    });
    observeVcs(state, {
      type: "vcs.branch.updated",
      location: { directory: "/tmp/project" },
      data: { branch: "A" },
    });
    assert.equal(state.branch.generation, 3);
    assert.equal(snapshot(state).branch, "A");
  });

  it("ignores VCS events from another location", () => {
    const state = testState();
    state.branch.generation = 1;
    observeVcs(state, {
      type: "vcs.branch.updated",
      location: { directory: "/tmp/other" },
      data: { branch: "other" },
    });
    assert.equal(state.branch.generation, 1);
    assert.equal(state.branch.desiredBranch, "main");
  });
});

describe("coalesced synchronization", () => {
  it("preserves a pending request while waiting for an active capture", async () => {
    fake = await installFakeMemoir();
    const state = testState();
    const barrier = deferred();
    state.activeCapture = {
      branch: "main",
      provider: "git",
      generation: 1,
      vcsKnown: true,
      done: barrier.promise,
    };

    requestSync(state);
    await wait(30);
    assert.equal(state.branch.syncWanted, true);
    assert.equal(await checkoutCount(fake), 0);

    barrier.resolve();
    state.activeCapture = undefined;
    const pending = state.branch.syncPromise;
    assert.ok(pending);
    await pending;
    assert.equal(await checkoutCount(fake), 1);
    assert.equal(state.branch.syncWanted, false);
  });

  it("revalidates after acquiring the lock and preserves pending work", async () => {
    fake = await installFakeMemoir();
    const state = testState();
    const barrier = deferred();
    requestSync(state);
    state.activeCapture = {
      branch: "main",
      provider: "git",
      generation: 1,
      vcsKnown: true,
      done: barrier.promise,
    };

    await wait(30);
    assert.equal(await checkoutCount(fake), 0);
    assert.equal(state.branch.syncWanted, true);

    barrier.resolve();
    state.activeCapture = undefined;
    const pending = state.branch.syncPromise;
    assert.ok(pending);
    await pending;
    assert.equal(await checkoutCount(fake), 1);
    assert.equal(state.branch.syncWanted, false);
  });

  it("processes the latest desired branch when it changes during a checkout", async () => {
    fake = await installFakeMemoir();
    fake.setSleep(1);
    const state = testState();
    requestSync(state);
    const current = fake;
    assert.ok(current);
    await waitFor(async () => {
      const calls = await current.calls();
      return calls.includes("checkout") && calls.includes("main");
    });

    setBranch(state, "feature", 2);
    const pending = state.branch.syncPromise;
    assert.ok(pending);
    await pending;
    const calls = await fake.calls();
    assert.ok(calls.includes("main"));
    assert.ok(calls.includes("feature"));
  });

  it("does not manufacture a checkout after a safe capture without a pending VCS request", async () => {
    fake = await installFakeMemoir();
    const state = testState();
    afterCapture(state, "succeeded", false);
    await wait(30);
    assert.equal(await checkoutCount(fake), 0);
    assert.equal(state.branch.syncWanted, false);
  });

  it("resumes a genuine pending sync after a safe capture", async () => {
    fake = await installFakeMemoir();
    const state = testState();
    state.branch.syncWanted = true;
    afterCapture(state, "succeeded", false);
    const pending = state.branch.syncPromise;
    assert.ok(pending);
    await pending;
    assert.equal(await checkoutCount(fake), 1);
  });

  it("safe interrupted suppresses immediate sync and a later VCS event retries", async () => {
    fake = await installFakeMemoir();
    const state = testState();
    state.branch.syncWanted = true;
    afterCapture(state, "interrupted", false);
    await wait(30);
    assert.equal(state.branch.syncMode, "suppressed");
    assert.equal(await checkoutCount(fake), 0);

    observeVcs(state, {
      type: "vcs.branch.updated",
      location: { directory: "/tmp/project" },
      data: { branch: "feature" },
    });
    const pending = state.branch.syncPromise;
    assert.ok(pending);
    await pending;
    assert.equal(await checkoutCount(fake), 1);
  });

  it("ambiguous capture sets unsafe and blocks future sync", async () => {
    fake = await installFakeMemoir();
    const state = testState();
    afterCapture(state, "succeeded", true);
    observeVcs(state, {
      type: "vcs.branch.updated",
      location: { directory: "/tmp/project" },
      data: { branch: "feature" },
    });
    await wait(30);
    assert.equal(state.branch.syncMode, "unsafe");
    assert.equal(await checkoutCount(fake), 0);
    await assert.rejects(() => awaitReady(state));
  });

  it("a failed checkout is not retried until a new VCS event", async () => {
    fake = await installFakeMemoir();
    fake.setExit(1);
    const state = testState();

    requestSync(state);
    const first = state.branch.syncPromise;
    assert.ok(first);
    await first;
    assert.equal(await checkoutCount(fake), 1);
    assert.ok(state.branch.syncError);
    await wait(40);
    assert.equal(await checkoutCount(fake), 1);

    fake.setExit(0);
    observeVcs(state, {
      type: "vcs.branch.updated",
      location: { directory: "/tmp/project" },
      data: { branch: "feature" },
    });
    const second = state.branch.syncPromise;
    assert.ok(second);
    await second;
    assert.equal(await checkoutCount(fake), 2);
  });
});

describe("wait-only guard", () => {
  async function guardFor(state: MemoirState) {
    let callback: ((event: unknown) => Promise<void>) | undefined;
    const ctx = {
      tool: {
        hook: async (_name: string, cb: (event: unknown) => Promise<void>) => {
          callback = cb;
          return { dispose: async () => undefined };
        },
      },
    } as unknown as Plugin.Context;
    const registration = await registerMemoirToolGuard(ctx, state);
    assert.ok(callback);
    return { callback, registration };
  }

  it("skips the adapter's own capture session without waiting on itself", async () => {
    const state = testState();
    state.mcpReady = true;

    const barrier = deferred();
    state.activeCapture = {
      captureSessionID: "capture-session",
      branch: "main",
      provider: "git",
      generation: 1,
      vcsKnown: true,
      done: barrier.promise,
    };
    const { callback } = await guardFor(state);
    await callback({
      info: { options: { namespace: "memoir" } },
      sessionID: "capture-session",
    } as never);
    barrier.resolve();
  });

  it("rejects foreground Memoir tools while suppressed", async () => {
    const state = testState();
    state.mcpReady = true;

    state.branch.syncMode = "suppressed";
    const { callback } = await guardFor(state);
    await assert.rejects(
      () =>
        callback({
          info: { options: { namespace: "memoir" } },
          sessionID: "parent-session",
        } as never),
      (error: unknown) => error instanceof Tool.Error,
    );
  });

  it("ignores tools from other namespaces", async () => {
    const state = testState();
    state.mcpReady = true;

    const { callback } = await guardFor(state);
    await callback({
      info: { options: { namespace: "another-server" } },
      sessionID: "parent-session",
    } as never);
  });
});
