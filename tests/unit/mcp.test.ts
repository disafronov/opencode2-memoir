import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Mcp, Plugin } from "@opencode/plugin";
import {
  MEMOIR_SERVER_NAME,
  MEMOIR_TOOL_PREFIX,
  memoirConfig,
  permissionRules,
  registerMemoirMcp,
} from "../../src/mcp.js";
import { createState } from "../../src/state.js";

type Editor = {
  list(): readonly [string, Mcp.ServerConfig][];
  get(name: string): Mcp.ServerConfig | undefined;
  set(name: string, config: Mcp.ServerConfig): void;
};

type TransformCapture = { callbacks: Array<(editor: Editor) => void> };

function harness(entries: Record<string, Mcp.ServerConfig>): {
  ctx: Plugin.Context;
  entries: Record<string, Mcp.ServerConfig>;
  transforms: TransformCapture;
  applied: () => void;
} {
  const transforms: TransformCapture = { callbacks: [] };
  const ctx = {
    mcp: {
      transform: async (callback: (editor: Editor) => void) => {
        transforms.callbacks.push(callback);
        callback({
          list: () => Object.entries(entries),
          get: (name) => entries[name],
          set: (name, config) => {
            entries[name] = config;
          },
        });
        return { dispose: async () => undefined };
      },
      reload: async () => undefined,
    },
    location: {
      directory: "/tmp/project",
      project: { id: "p", directory: "/tmp/project", canonical: "/tmp/project" },
    },
    options: {},
  } as unknown as Plugin.Context;
  const applied = () => {
    for (const callback of transforms.callbacks) {
      callback({
        list: () => Object.entries(entries),
        get: (name) => entries[name],
        set: (name, config) => {
          entries[name] = config;
        },
      });
    }
  };
  return { ctx, entries, transforms, applied };
}

function testState(ctx: Plugin.Context) {
  return createState(ctx, "/tmp/store");
}

describe("MCP ownership", () => {
  it("uses the fixed memoir namespace and memoir_ tool prefix", () => {
    assert.equal(MEMOIR_SERVER_NAME, "memoir");
    assert.equal(MEMOIR_TOOL_PREFIX, "memoir_");
  });

  it("registers under the exact name memoir when no such server is configured", async () => {
    const h = harness({});
    await registerMemoirMcp(h.ctx, testState(h.ctx));
    assert.deepEqual(h.entries.memoir, memoirConfig("/tmp/store"));
  });

  it("unconditionally overrides a user-defined memoir configuration", async () => {
    const user: Mcp.ServerConfig = { type: "local", command: ["sleep", "60"], disabled: false };
    const h = harness({ memoir: user });
    await registerMemoirMcp(h.ctx, testState(h.ctx));
    assert.deepEqual(h.entries.memoir, memoirConfig("/tmp/store"));
    assert.notDeepEqual(h.entries.memoir, user);
  });

  it("does not modify unrelated MCP servers", async () => {
    const other: Mcp.ServerConfig = { type: "remote", url: "http://127.0.0.1:1", codemode: false };
    const local: Mcp.ServerConfig = { type: "local", command: ["sleep", "1"] };
    const h = harness({ memoir: { type: "local", command: ["sleep", "60"] }, other, local });
    await registerMemoirMcp(h.ctx, testState(h.ctx));
    assert.deepEqual(h.entries.other, other);
    assert.deepEqual(h.entries.local, local);
  });

  it("applies the configuration on every invocation, including reloads", async () => {
    const h = harness({});
    const state = testState(h.ctx);
    await registerMemoirMcp(h.ctx, state);
    const desired = memoirConfig("/tmp/store");

    // A user re-adds a conflicting memoir entry; a reload re-applies ours.
    h.entries.memoir = { type: "local", command: ["sleep", "60"] };
    h.applied();
    assert.deepEqual(h.entries.memoir, desired);

    // Our entry is removed; a reload restores it.
    delete h.entries.memoir;
    h.applied();
    assert.deepEqual(h.entries.memoir, desired);

    // Registering again on the same instance still applies unconditionally.
    h.entries.memoir = { type: "remote", url: "http://127.0.0.1:1" };
    await registerMemoirMcp(h.ctx, state);
    assert.deepEqual(h.entries.memoir, desired);
  });

  it("marks MCP ready on every applied transform", async () => {
    const h = harness({});
    const state = testState(h.ctx);
    let readyCalls = 0;
    state.onReady = () => {
      readyCalls++;
    };
    assert.equal(state.mcpReady, false);
    await registerMemoirMcp(h.ctx, state);
    assert.equal(state.mcpReady, true);
    const before = readyCalls;
    h.applied();
    assert.ok(readyCalls > before);
  });
});

describe("memoirConfig", () => {
  it("is a disabled-protocol local memoir-mcp server for the store", () => {
    assert.deepEqual(memoirConfig("/tmp/store"), {
      type: "local",
      command: ["memoir-mcp", "--store", "/tmp/store"],
      cwd: "/tmp/store",
      environment: { MEMOIR_STORE: "/tmp/store" },
      codemode: false,
      protocol: "legacy",
      disabled: false,
    });
  });
});

describe("capture permissions", () => {
  it("uses deny-all, doom-loop, memoir_ allow, then checkout/forget denies", () => {
    assert.deepEqual(permissionRules(), [
      { action: "*", resource: "*", effect: "deny" },
      { action: "doom_loop", resource: "*", effect: "allow" },
      { action: "memoir_*", resource: "*", effect: "allow" },
      { action: "memoir_*memoir_forget", resource: "*", effect: "deny" },
      { action: "memoir_*memoir_checkout", resource: "*", effect: "deny" },
    ]);
  });
});
