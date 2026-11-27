import type { Mcp, Plugin } from "@opencode/plugin";
import type { MemoirState } from "./state.js";

/** OpenCode's MCP namespace normalization. */
export function normalizeServerName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Effective tool prefix derived from the selected server name. */
export function toolPrefix(serverName: string): string {
  return `${normalizeServerName(serverName).replaceAll(".", "_")}_`;
}

/** Local MCP configuration for the project store. */
export function memoirConfig(storePath: string): Mcp.ServerConfig {
  return {
    type: "local",
    command: ["memoir-mcp", "--store", storePath],
    cwd: storePath,
    environment: { MEMOIR_STORE: storePath },
    codemode: false,
    protocol: "legacy",
    disabled: false,
  };
}

/** Compare the adapter-owned local config with an existing editor entry. */
export function sameMcpConfig(a: Mcp.ServerConfig | undefined, b: Mcp.ServerConfig): boolean {
  if (a?.type !== "local" || b.type !== "local") return false;
  const left = a as Extract<Mcp.ServerConfig, { type: "local" }>;
  const right = b as Extract<Mcp.ServerConfig, { type: "local" }>;
  return (
    left.command.length === right.command.length &&
    left.command.every((value, index) => value === right.command[index]) &&
    left.cwd === right.cwd &&
    left.environment?.MEMOIR_STORE === right.environment?.MEMOIR_STORE &&
    left.codemode === false &&
    left.protocol === "legacy" &&
    left.disabled !== true
  );
}

/**
 * Choose one deterministic adapter-owned server name.
 *
 * The base name is always hashed. A suffix is used only when OpenCode's
 * normalized namespace would collide with another configured server. An
 * exact existing entry with the same config is reused.
 */
export function selectServerName(
  editor: {
    list(): readonly [string, Mcp.ServerConfig][];
    get(name: string): Mcp.ServerConfig | undefined;
  },
  desired: Mcp.ServerConfig,
  storeHash: string,
): string {
  const base = `memoir_plugin_${storeHash}`;
  const names = editor.list();
  for (let index = 1; index < 1000; index++) {
    const candidate = index === 1 ? base : `${base}_${index}`;
    const normalized = normalizeServerName(candidate);
    const normalizedCollision = names.some(
      ([name]) => name !== candidate && normalizeServerName(name) === normalized,
    );
    if (normalizedCollision) continue;

    const existing = editor.get(candidate);
    if (existing) {
      if (sameMcpConfig(existing, desired)) return candidate;
      continue;
    }
    return candidate;
  }
  throw new Error("could not find a free Memoir MCP server name");
}

/** Capture-agent permission rules, ordered for OpenCode's last-match semantics. */
export function permissionRules(prefix: string): Array<{
  action: string;
  resource: string;
  effect: "allow" | "deny";
}> {
  return [
    { action: "*", resource: "*", effect: "deny" },
    { action: "doom_loop", resource: "*", effect: "allow" },
    { action: `${prefix}*`, resource: "*", effect: "allow" },
    { action: `${prefix}*memoir_forget`, resource: "*", effect: "deny" },
    { action: `${prefix}*memoir_checkout`, resource: "*", effect: "deny" },
  ];
}

/**
 * Register the adapter's local MCP server without touching any other server.
 * The selected name/config is frozen for the lifetime of the setup instance.
 */
export async function registerMemoirMcp(ctx: Plugin.Context, state: MemoirState): Promise<void> {
  const desired = memoirConfig(state.storePath);

  // The MCP transform callback is applied after plugin setup returns, so the
  // base namespace must be fixed synchronously before the agent/guard exist.
  // A collision is resolved in the callback; the base tool prefix still
  // matches a suffixed name, while the namespace state is updated for the
  // context filter and tool guard.
  const base = `memoir_plugin_${state.storeHash}`;
  state.serverName = base;
  state.namespace = normalizeServerName(base);
  state.toolPrefix = toolPrefix(base);

  await ctx.mcp.transform((editor) => {
    const preferred = state.serverName ?? base;

    // Once this instance selected a name, a later transform must never rename
    // it. If the frozen name was taken by a different config, disable the
    // adapter-owned MCP features for this instance instead of overwriting it.
    if (state.mcpSelected) {
      const normalized = normalizeServerName(preferred);
      const normalizedCollision = editor
        .list()
        .some(([name]) => name !== preferred && normalizeServerName(name) === normalized);
      const existing = editor.get(preferred);
      if (normalizedCollision || (existing && !sameMcpConfig(existing, desired))) {
        state.mcpRegistered = false;
        state.mcpReady = false;
        state.onReady?.();
        console.error(
          "[memoir] frozen MCP server name is no longer uniquely owned; MCP features disabled",
        );
        return;
      }
      if (!existing) editor.set(preferred, desired);
      state.mcpReady = true;
      state.onReady?.();
      return;
    }

    const selected = selectServerName(editor, desired, state.storeHash);
    state.serverName = selected;
    state.namespace = normalizeServerName(selected);
    if (!editor.get(selected)) editor.set(selected, desired);
    state.mcpSelected = true;
    state.mcpRegistered = true;
    state.mcpReady = true;
    state.onReady?.();
  });
}
