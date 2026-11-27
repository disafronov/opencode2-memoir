import type { Mcp, Plugin } from "@opencode/plugin";
import type { MemoirState } from "./state.js";

/** Fixed MCP server name; the plugin is the authoritative owner of `memoir`. */
export const MEMOIR_SERVER_NAME = "memoir";

/** Effective OpenCode tool prefix for the `memoir` namespace. */
export const MEMOIR_TOOL_PREFIX = `${MEMOIR_SERVER_NAME}_`;

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

/** Capture-agent permission rules, ordered for OpenCode's last-match semantics. */
export function permissionRules(): Array<{
  action: string;
  resource: string;
  effect: "allow" | "deny";
}> {
  return [
    { action: "*", resource: "*", effect: "deny" },
    { action: "doom_loop", resource: "*", effect: "allow" },
    { action: `${MEMOIR_TOOL_PREFIX}*`, resource: "*", effect: "allow" },
    { action: `${MEMOIR_TOOL_PREFIX}*memoir_forget`, resource: "*", effect: "deny" },
    { action: `${MEMOIR_TOOL_PREFIX}*memoir_checkout`, resource: "*", effect: "deny" },
  ];
}

/**
 * Register the adapter's local MCP server as the authoritative `memoir` owner.
 *
 * The callback is re-applied on every transform, including reloads: it always
 * sets `memoir` unconditionally, overriding any user-defined entry in memory,
 * never modifying user configuration files, and never touching other servers.
 */
export async function registerMemoirMcp(ctx: Plugin.Context, state: MemoirState): Promise<void> {
  const desired = memoirConfig(state.storePath);
  await ctx.mcp.transform((editor) => {
    editor.set(MEMOIR_SERVER_NAME, desired);
    state.mcpReady = true;
    state.onReady?.();
  });
}
