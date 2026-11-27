import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CommandInvocation, Plugin } from "@opencode/plugin";
import { registerCaptureToolFilter, registerOnboardCommand } from "../../src/agent.js";
import { createState } from "../../src/state.js";

function state() {
  const value = createState(
    {
      location: {
        directory: "/tmp/project",
        project: { id: "p", directory: "/tmp/project", canonical: "/tmp/project" },
      },
      options: {},
    } as unknown as Plugin.Context,
    "/tmp",
    "hash",
  );
  value.namespace = "memoir_plugin_x";
  value.serverName = "memoir_plugin_x";
  value.branchSyncEnabled = true;
  value.onboardEnabled = true;
  return value;
}

describe("capture tool filter", () => {
  it("keeps only the selected Memoir namespace (minus checkout/forget) and doom_loop", async () => {
    const value = state();
    let callback: ((event: unknown) => Promise<void>) | undefined;
    const ctx = {
      tool: {
        list: async () => [
          {
            id: "memoir_plugin_x_memoir_remember",
            name: "memoir_remember",
            options: { namespace: "memoir_plugin_x" },
          },
          {
            id: "memoir_plugin_x_memoir_checkout",
            name: "memoir_checkout",
            options: { namespace: "memoir_plugin_x" },
          },
          {
            id: "memoir_plugin_x_memoir_forget",
            name: "memoir_forget",
            options: { namespace: "memoir_plugin_x" },
          },
          { id: "doom_loop", name: "doom_loop" },
          { id: "skill", name: "skill" },
          {
            id: "memoir_other_memoir_remember",
            name: "memoir_remember",
            options: { namespace: "memoir_other" },
          },
          {
            id: "memoir_plugin_x_evil_memoir_remember",
            name: "memoir_remember",
            options: { namespace: "memoir_plugin_x_evil" },
          },
        ],
      },
      session: {
        hook: async (_name: string, cb: (event: unknown) => Promise<void>) => {
          callback = cb;
          return { dispose: async () => undefined };
        },
      },
    } as unknown as Plugin.Context;
    await registerCaptureToolFilter(ctx, value);
    assert.ok(callback);
    const event = {
      agent: "memoir",
      tools: {
        memoir_plugin_x_memoir_remember: {},
        memoir_plugin_x_memoir_checkout: {},
        memoir_plugin_x_memoir_forget: {},
        doom_loop: {},
        skill: {},
        memoir_other_memoir_remember: {},
        memoir_plugin_x_evil_memoir_remember: {},
      },
    };
    await callback(event);
    assert.deepEqual(Object.keys(event.tools), ["memoir_plugin_x_memoir_remember", "doom_loop"]);
  });
});

describe("onboarding command", () => {
  it("sends the generated prompt, selected server, and arguments to the current session", async () => {
    const value = state();
    let definition: { execute: (input: CommandInvocation) => Promise<void> } | undefined;
    let delivered: { sessionID: string; text: string; delivery: string } | undefined;
    const ctx = {
      command: {
        transform: async (cb: (editor: { add: (value: typeof definition) => void }) => void) => {
          cb({ add: (value) => (definition = value) });
          return { dispose: async () => undefined };
        },
      },
      session: {
        prompt: async (input: { sessionID: string; text: string; delivery: string }) => {
          delivered = input;
        },
      },
    } as unknown as Plugin.Context;

    await registerOnboardCommand(ctx, value, "ONBOARD PROMPT", async () => undefined);
    assert.ok(definition);
    await definition.execute({
      sessionID: "ses_parent",
      prompt: { text: "--force" },
      delivery: "queue",
    } as unknown as CommandInvocation);
    assert.equal(delivered?.sessionID, "ses_parent");
    assert.match(delivered?.text ?? "", /ONBOARD PROMPT/);
    assert.match(delivered?.text ?? "", /Selected Memoir MCP server: memoir_plugin_x/);
    assert.match(delivered?.text ?? "", /--force/);
    assert.equal(delivered?.delivery, "queue");
  });

  it("refuses onboarding while sync is suppressed", async () => {
    const value = state();
    value.branch.syncMode = "suppressed";
    let definition: { execute: (input: CommandInvocation) => Promise<void> } | undefined;
    const ctx = {
      command: {
        transform: async (cb: (editor: { add: (value: typeof definition) => void }) => void) => {
          cb({ add: (value) => (definition = value) });
          return { dispose: async () => undefined };
        },
      },
    } as unknown as Plugin.Context;
    await registerOnboardCommand(ctx, value, "P", async () => undefined);
    assert.ok(definition);
    const execute = definition.execute;
    await assert.rejects(
      () =>
        execute({
          sessionID: "ses_parent",
          prompt: { text: "" },
          delivery: "queue",
        } as unknown as CommandInvocation),
      /unavailable/,
    );
  });
});
