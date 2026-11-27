import { Agent, type Plugin } from "@opencode/plugin";
import { permissionRules } from "./mcp.js";
import type { MemoirState } from "./state.js";

type Registration = { dispose: () => Promise<void> };

/** Register the hidden capture agent. No model/temperature/steps overrides. */
export async function registerCaptureAgent(
  ctx: Plugin.Context,
  state: MemoirState,
  systemPrompt: string,
): Promise<void> {
  if (!state.toolPrefix) throw new Error("Memoir MCP namespace is not available");
  const prefix = state.toolPrefix;

  await ctx.agent.transform((editor) => {
    editor.update("memoir", (agent) => {
      agent.name = Agent.Name.make("memoir");
      agent.description =
        "Memoir memory agent: turns completed conversations into durable project memory.";
      agent.mode = "subagent";
      agent.hidden = true;
      agent.system = systemPrompt;
      agent.permissions = permissionRules(prefix).map((rule) => ({
        action: rule.action,
        resource: rule.resource,
        effect: rule.effect,
      }));
    });
  });
}

/**
 * Filter the capture agent's request-time tool list to the selected Memoir
 * namespace. This removes the `skill` visibility exception and any unrelated
 * tool without touching other agents.
 */
export async function registerCaptureToolFilter(
  ctx: Plugin.Context,
  state: MemoirState,
): Promise<Registration> {
  return ctx.session.hook("context", async (event) => {
    if (event.agent !== "memoir") return;

    try {
      const tools = await ctx.tool.list();
      const allowed = new Set<string>();
      for (const tool of tools) {
        if (tool.options?.namespace === state.namespace) {
          if (tool.name === "memoir_checkout" || tool.name === "memoir_forget") continue;
          allowed.add(tool.id);
        }
      }
      if ("doom_loop" in event.tools) allowed.add("doom_loop");

      for (const key of Object.keys(event.tools)) {
        if (!allowed.has(key)) delete event.tools[key];
      }
    } catch (error) {
      console.error("[memoir] capture tool filter failed; removing all tools", error);
      for (const key of Object.keys(event.tools)) delete event.tools[key];
    }
  });
}

/** Register /memoir:onboard as a command that prompts the current session. */
export async function registerOnboardCommand(
  ctx: Plugin.Context,
  state: MemoirState,
  prompt: string,
  awaitReady: () => Promise<void>,
): Promise<Registration> {
  let registered = false;
  return ctx.command.transform((editor) => {
    if (registered) return;
    editor.add({
      name: "memoir:onboard",
      description: "Populate or refresh the project snapshot in Memoir",
      execute: async (input) => {
        if (!state.onboardEnabled || state.branch.syncMode !== "ok" || !state.branchSyncEnabled) {
          throw new Error("Memoir onboarding is unavailable");
        }
        await awaitReady();

        const value = (input as { prompt?: unknown }).prompt;
        const args =
          typeof value === "string"
            ? value
            : value && typeof value === "object" && "text" in value
              ? String((value as { text?: unknown }).text ?? "")
              : "";

        const text =
          `${prompt}\n\nSelected Memoir MCP server: ${state.serverName ?? "(unavailable)"}` +
          (args.trim() ? `\nUser arguments: ${args.trim()}` : "");

        await ctx.session.prompt({
          sessionID: input.sessionID,
          text,
          delivery: input.delivery,
        });
      },
    });
    registered = true;
  });
}
