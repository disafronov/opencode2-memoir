import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Mcp, Plugin } from "@opencode/plugin";
import {
  memoirConfig,
  normalizeServerName,
  permissionRules,
  registerMemoirMcp,
  sameMcpConfig,
  selectServerName,
  toolPrefix,
} from "../../src/mcp.js";
import { createState } from "../../src/state.js";

type Editor = {
  list(): readonly [string, Mcp.ServerConfig][];
  get(name: string): Mcp.ServerConfig | undefined;
};

function editor(entries: Record<string, Mcp.ServerConfig> = {}): Editor {
  return {
    list: () => Object.entries(entries),
    get: (name) => entries[name],
  };
}

describe("MCP names", () => {
  it("normalizes exactly like OpenCode", () => {
    assert.equal(normalizeServerName("memoir.a"), "memoir_a");
    assert.equal(normalizeServerName("memoir-a"), "memoir-a");
    assert.equal(toolPrefix("memoir_plugin_abc"), "memoir_plugin_abc_");
  });

  it("uses a stable hash name and preserves unrelated servers", () => {
    const desired = memoirConfig("/tmp/store");
    const selected = selectServerName(
      editor({ memoir: { type: "local", command: ["sleep", "1"] } }),
      desired,
      "abc123",
    );
    assert.equal(selected, "memoir_plugin_abc123");
  });

  it("suffixes on an exact occupied different config", () => {
    const desired = memoirConfig("/tmp/store");
    const selected = selectServerName(
      editor({
        memoir_plugin_abc123: {
          type: "local",
          command: ["sleep", "1"],
        },
      }),
      desired,
      "abc123",
    );
    assert.equal(selected, "memoir_plugin_abc123_2");
  });

  it("suffixes on a normalized collision even when the exact name is free", () => {
    const desired = memoirConfig("/tmp/store");
    const selected = selectServerName(
      editor({
        "memoir.plugin.abc123": {
          type: "local",
          command: ["sleep", "1"],
        },
      }),
      desired,
      "abc123",
    );
    assert.equal(selected, "memoir_plugin_abc123_2");
  });

  it("reuses an exact identical config", () => {
    const desired = memoirConfig("/tmp/store");
    const selected = selectServerName(editor({ memoir_plugin_abc123: desired }), desired, "abc123");
    assert.equal(selected, "memoir_plugin_abc123");
    assert.equal(sameMcpConfig(desired, desired), true);
  });

  it("rejects an exact identical config when another server normalizes to the same namespace", () => {
    const desired = memoirConfig("/tmp/store");
    const selected = selectServerName(
      editor({
        memoir_plugin_abc123: desired,
        "memoir.plugin.abc123": { type: "local", command: ["sleep", "1"] },
      }),
      desired,
      "abc123",
    );
    assert.equal(selected, "memoir_plugin_abc123_2");
  });

  it("registers without overwriting unrelated servers and freezes the namespace", async () => {
    const desired = memoirConfig("/tmp/store");
    const entries: Record<string, Mcp.ServerConfig> = { memoir: desired };
    const ctx = {
      mcp: {
        transform: async (
          callback: (
            editor: Editor & { set: (name: string, config: Mcp.ServerConfig) => void },
          ) => void,
        ) => {
          const list = () => Object.entries(entries);
          const get = (name: string) => entries[name];
          const set = (name: string, config: Mcp.ServerConfig) => {
            entries[name] = config;
          };
          callback({ list, get, set });
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
    const value = createState(ctx, "/tmp/store", "abc123");
    await registerMemoirMcp(ctx, value);
    assert.equal(value.serverName, "memoir_plugin_abc123");
    assert.equal(value.namespace, "memoir_plugin_abc123");
    assert.equal(value.toolPrefix, "memoir_plugin_abc123_");
    assert.equal(value.mcpRegistered, true);
    assert.ok(entries.memoir);
    assert.ok(entries.memoir_plugin_abc123);
  });

  it("does not rename a frozen registration when a later transform collides", async () => {
    const entries: Record<string, Mcp.ServerConfig> = {};
    const ctx = {
      mcp: {
        transform: async (
          callback: (
            editor: Editor & { set: (name: string, config: Mcp.ServerConfig) => void },
          ) => void,
        ) => {
          callback({
            list: () => Object.entries(entries),
            get: (name) => entries[name],
            set: (name, config) => {
              entries[name] = config;
            },
          });
          return { dispose: async () => undefined };
        },
      },
      location: {
        directory: "/tmp/project",
        project: { id: "p", directory: "/tmp/project", canonical: "/tmp/project" },
      },
      options: {},
    } as unknown as Plugin.Context;
    const value = createState(ctx, "/tmp/store", "abc123");
    await registerMemoirMcp(ctx, value);
    assert.equal(value.serverName, "memoir_plugin_abc123");
    assert.equal(value.mcpSelected, true);

    entries.memoir_plugin_abc123 = { type: "local", command: ["sleep", "1"] };
    await registerMemoirMcp(ctx, value);
    assert.equal(value.serverName, "memoir_plugin_abc123");
    assert.equal(value.mcpRegistered, false);
    assert.equal(value.mcpReady, false);
    assert.deepEqual(entries.memoir_plugin_abc123.command, ["sleep", "1"]);

    // A later transform must not select a new name after the frozen one is lost.
    await registerMemoirMcp(ctx, value);
    assert.equal(value.serverName, "memoir_plugin_abc123");
    assert.equal(value.mcpRegistered, false);
  });

  it("disables a frozen registration when a later server normalizes to the same namespace", async () => {
    const entries: Record<string, Mcp.ServerConfig> = {};
    const ctx = {
      mcp: {
        transform: async (
          callback: (
            editor: Editor & { set: (name: string, config: Mcp.ServerConfig) => void },
          ) => void,
        ) => {
          callback({
            list: () => Object.entries(entries),
            get: (name) => entries[name],
            set: (name, config) => {
              entries[name] = config;
            },
          });
          return { dispose: async () => undefined };
        },
      },
      location: {
        directory: "/tmp/project",
        project: { id: "p", directory: "/tmp/project", canonical: "/tmp/project" },
      },
      options: {},
    } as unknown as Plugin.Context;
    const value = createState(ctx, "/tmp/store", "abc123");
    await registerMemoirMcp(ctx, value);
    assert.equal(value.serverName, "memoir_plugin_abc123");

    entries["memoir.plugin.abc123"] = { type: "local", command: ["sleep", "1"] };
    await registerMemoirMcp(ctx, value);
    assert.equal(value.mcpRegistered, false);
    assert.equal(value.mcpReady, false);
    assert.equal(value.serverName, "memoir_plugin_abc123");
  });

  it("resolves an occupied base name with a suffix and updates the namespace", async () => {
    const entries: Record<string, Mcp.ServerConfig> = {
      memoir_plugin_abc123: { type: "local", command: ["sleep", "1"] },
    };
    const ctx = {
      mcp: {
        transform: async (
          callback: (
            editor: Editor & { set: (name: string, config: Mcp.ServerConfig) => void },
          ) => void,
        ) => {
          const list = () => Object.entries(entries);
          const get = (name: string) => entries[name];
          const set = (name: string, config: Mcp.ServerConfig) => {
            entries[name] = config;
          };
          callback({ list, get, set });
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
    const value = createState(ctx, "/tmp/store", "abc123");
    await registerMemoirMcp(ctx, value);
    assert.equal(value.serverName, "memoir_plugin_abc123_2");
    assert.equal(value.namespace, "memoir_plugin_abc123_2");
    assert.equal(value.toolPrefix, "memoir_plugin_abc123_");
    assert.ok(entries.memoir_plugin_abc123);
    assert.ok(entries.memoir_plugin_abc123_2);
  });

  it("does not consider a remote or altered local config identical", () => {
    const desired = memoirConfig("/tmp/store");
    assert.equal(
      sameMcpConfig({ type: "remote", url: "http://127.0.0.1:1", codemode: false }, desired),
      false,
    );
    assert.equal(
      sameMcpConfig(
        {
          ...desired,
          type: "local",
          command: ["memoir-mcp", "--store", "/tmp/other"],
          cwd: "/tmp/other",
        },
        desired,
      ),
      false,
    );
  });
});

describe("capture permissions", () => {
  it("uses deny-all, doom-loop, namespace allow, then checkout/forget denies", () => {
    assert.deepEqual(permissionRules("memoir_plugin_x_"), [
      { action: "*", resource: "*", effect: "deny" },
      { action: "doom_loop", resource: "*", effect: "allow" },
      { action: "memoir_plugin_x_*", resource: "*", effect: "allow" },
      { action: "memoir_plugin_x_*memoir_forget", resource: "*", effect: "deny" },
      { action: "memoir_plugin_x_*memoir_checkout", resource: "*", effect: "deny" },
    ]);
  });
});
