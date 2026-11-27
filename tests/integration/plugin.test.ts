import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { hashStore, safeRealpath } from "../../src/store.js";
import {
  type FakeModel,
  installAmbiguousMcp,
  type OpenCodeHarness,
  startFakeModel,
  startOpenCode,
} from "./harness.js";

const exec = promisify(execFile);

const TIMEOUT = 180_000;

async function waitForAdapter(h: OpenCodeHarness): Promise<Record<string, unknown>> {
  await h.waitFor(async () => {
    const servers = await h.mcp();
    return servers.some(
      (server) =>
        String(server.name).startsWith("memoir_plugin_") &&
        (server.status as { status?: string } | undefined)?.status === "connected",
    );
  });
  const servers = (await h.mcp())
    .filter(
      (item) =>
        String(item.name).startsWith("memoir_plugin_") &&
        (item.status as { status?: string } | undefined)?.status === "connected",
    )
    .sort((left, right) => String(left.name).localeCompare(String(right.name)));
  const server = servers.at(-1);
  assert.ok(server, "adapter MCP server not found");
  return server;
}

async function waitForMain(h: OpenCodeHarness): Promise<void> {
  await h.waitFor(async () => (await h.status())?.branch === "main");
}

function captureRequests(model: FakeModel) {
  return model.requests.filter((request) => request.isCapture);
}

function captureStarts(model: FakeModel) {
  return model.requests.filter((request) => request.isCapture && request.lastRole !== "tool");
}

async function dispose(
  h: OpenCodeHarness | undefined,
  model: FakeModel | undefined,
  shim?: { cleanup: () => Promise<void> },
): Promise<void> {
  if (h) {
    await h.stop().catch(() => undefined);
    await rm(h.root, { recursive: true, force: true }).catch(() => undefined);
  }
  await model?.close().catch(() => undefined);
  await shim?.cleanup().catch(() => undefined);
}

test("local MCP, store, branch sync, capture, permissions, and cleanup", {
  timeout: TIMEOUT,
}, async () => {
  const model = await startFakeModel();
  let h: OpenCodeHarness | undefined;
  try {
    h = await startOpenCode({ modelUrl: model.url, userMcp: true });
    const adapter = await waitForAdapter(h);
    const adapterName = String(adapter.name);
    const prefix = `${adapterName}_`;

    const servers = await h.mcp();
    assert.ok(
      servers.some((server) => server.name === "memoir"),
      "user-configured memoir server was not preserved",
    );
    assert.ok(
      servers.some((server) => String(server.name).startsWith("memoir_plugin_")),
      "adapter-owned MCP server is missing",
    );

    const agents = await h.agents();
    const memoirAgent = agents.find((agent) => agent.name === "memoir" || agent.id === "memoir");
    assert.ok(memoirAgent, "hidden memoir agent missing");
    assert.equal(memoirAgent.hidden, true);
    assert.equal(memoirAgent.mode, "subagent");

    await waitForMain(h);

    const sessionID = await h.createSession("integration");
    await h.prompt(sessionID, "hello from integration");
    await h.waitFor(() => h?.get("test.capture.fact"), 60_000);

    await h.waitFor(() => captureRequests(model).length >= 1);
    const capture = captureRequests(model)[0];
    assert.ok(capture);
    assert.match(capture.texts, /hello from integration/);
    assert.match(capture.texts, /ACK from deterministic model/);
    assert.ok(capture.toolNames.length > 0, "capture agent had no tools");
    for (const name of capture.toolNames) {
      const allowed =
        name === "doom_loop" || name === `${prefix}doom_loop` || name.startsWith(prefix);
      assert.ok(allowed, `unexpected capture-agent tool: ${name}`);
      assert.ok(!name.endsWith("memoir_checkout"), `checkout leaked to capture agent: ${name}`);
      assert.ok(!name.endsWith("memoir_forget"), `forget leaked to capture agent: ${name}`);
      assert.notEqual(name, "skill");
    }

    await h.waitFor(async () => {
      const sessions = await h?.sessions();
      return sessions.every((session) => session.title !== "memoir:capture");
    });
    const sessions = await h.sessions();
    assert.ok(
      sessions.some((session) => session.id === sessionID),
      "parent session was removed",
    );

    await h.git("checkout", "-b", "feature");
    await h.waitFor(async () => (await h?.status())?.branch === "feature");
  } finally {
    await dispose(h, model);
  }
});

test("resolves an adapter-name collision without touching user servers", {
  timeout: TIMEOUT,
}, async () => {
  const model = await startFakeModel({ capturePath: "test.capture.collision" });
  let h: OpenCodeHarness | undefined;
  try {
    h = await startOpenCode({
      modelUrl: model.url,
      userMcp: true,
      collideWithAdapter: true,
    });
    const adapter = await waitForAdapter(h);
    const adapterName = String(adapter.name);
    const base = `memoir_plugin_${hashStore(safeRealpath(h.store))}`;
    const servers = await h.mcp();
    assert.notEqual(adapterName, base);
    assert.ok(servers.some((server) => server.name === "memoir"));
    assert.ok(servers.some((server) => server.name === base));
    assert.ok(servers.some((server) => server.name === adapterName));

    const agents = await h.agents();
    const memoirAgent = agents.find((agent) => agent.name === "memoir" || agent.id === "memoir");
    assert.ok(memoirAgent);
    const rules = memoirAgent.permissions as Array<{ action: string; effect: string }>;
    assert.ok(rules.some((rule) => rule.action === `${base}_*` && rule.effect === "allow"));
    assert.ok(
      rules.some((rule) => rule.action === `${base}_*memoir_checkout` && rule.effect === "deny"),
    );
    assert.ok(
      rules.some((rule) => rule.action === `${base}_*memoir_forget` && rule.effect === "deny"),
    );

    const sessionID = await h.createSession("collision");
    await h.prompt(sessionID, "collision capture turn");
    await h.waitFor(() => h?.get("test.capture.collision"), 60_000);
    const capture = captureStarts(model)[0];
    assert.ok(capture);
    for (const name of capture.toolNames) {
      const allowed = name === "doom_loop" || name.startsWith(`${adapterName}_`);
      assert.ok(allowed, `capture agent received a non-selected tool: ${name}`);
    }
  } finally {
    await dispose(h, model);
  }
});

test("branch synchronization waits for an active capture", { timeout: TIMEOUT }, async () => {
  const model = await startFakeModel({ captureDelayMs: 3_000 });
  let h: OpenCodeHarness | undefined;
  try {
    h = await startOpenCode({ modelUrl: model.url });
    await waitForAdapter(h);
    await waitForMain(h);

    const sessionID = await h.createSession("overlap");
    await h.prompt(sessionID, "branch overlap turn");
    await h.waitFor(() => captureRequests(model).length >= 1);

    await h.git("checkout", "-b", "feature");
    await new Promise((resolve) => setTimeout(resolve, 300));
    const during = await h.status();
    assert.equal(during?.branch, "main", "branch sync ran while capture was active");

    await h.waitFor(() => h?.get("test.capture.fact"), 60_000);
    await h.waitFor(async () => (await h?.status())?.branch === "feature");
  } finally {
    await dispose(h, model);
  }
});

async function assertAmbiguous(failAfterTool: boolean): Promise<void> {
  const model = await startFakeModel({
    failAfterTool,
    capturePath: "test.capture.ambiguous",
  });
  const shim = await installAmbiguousMcp();
  let h: OpenCodeHarness | undefined;
  let h2: OpenCodeHarness | undefined;
  let restartModel: FakeModel | undefined;
  try {
    h = await startOpenCode({
      modelUrl: model.url,
      path: `${shim.dir}:${process.env.PATH ?? ""}`,
      env: {
        AMBIENT_LOG: join(shim.dir, "ambient.log"),
        AMBIENT_DELAY: "2",
      },
    });
    await waitForAdapter(h);
    await waitForMain(h);

    const sessionID = await h.createSession("ambiguous");
    await h.prompt(sessionID, "ambiguous terminal turn");
    await h.waitFor(() => captureRequests(model).length >= 1, 30_000);
    await h.waitFor(() => h?.get("test.capture.ambiguous"), 60_000);

    await h.prompt(sessionID, "[FOREGROUND] check status");
    await h.waitFor(async () => {
      const context = await h?.context(sessionID);
      return context.some(
        (message) =>
          message.type === "assistant" &&
          Array.isArray(message.content) &&
          message.content.some(
            (part: Record<string, unknown>) =>
              part.type === "tool" &&
              String(part.name).endsWith("memoir_status") &&
              (part.state as { status?: string } | undefined)?.status === "error",
          ),
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.ok(
      captureStarts(model).every((request) => !request.texts.includes("[FOREGROUND]")),
      "unsafe mode allowed a capture of the foreground turn",
    );

    // A full process restart is the documented recovery. It must start clean.
    await h.stop();
    await model.close();
    restartModel = await startFakeModel({ capturePath: "test.capture.afterrestart" });
    h2 = await startOpenCode({ modelUrl: restartModel.url, store: h.store });
    await waitForAdapter(h2);
    await waitForMain(h2);
    const restarted = await h2.createSession("after-restart");
    await h2.prompt(restarted, "after full restart");
    await h2.waitFor(() => h2?.get("test.capture.afterrestart"), 60_000);
  } finally {
    await dispose(h2, restartModel);
    await dispose(h, model, shim);
  }
}

test("ambiguous MCP termination with a successful session outcome", {
  timeout: TIMEOUT,
}, async () => {
  await assertAmbiguous(false);
});

test("ambiguous MCP termination with a failed session outcome", { timeout: TIMEOUT }, async () => {
  await assertAmbiguous(true);
});

test("foreground Memoir call waits for an active capture", { timeout: TIMEOUT }, async () => {
  const model = await startFakeModel({ captureDelayMs: 2_500 });
  let h: OpenCodeHarness | undefined;
  try {
    h = await startOpenCode({ modelUrl: model.url });
    await waitForAdapter(h);
    await waitForMain(h);

    const captureSession = await h.createSession("foreground-capture");
    await h.prompt(captureSession, "capture the foreground wait");
    await h.waitFor(() => captureRequests(model).length >= 1, 30_000);

    const foreground = await h.createSession("foreground-call");
    const started = Date.now();
    await h.prompt(foreground, "[FOREGROUND] status while capture is active");
    await h.waitFor(async () => {
      const context = await h?.context(foreground);
      return (
        context?.some(
          (message) =>
            message.type === "assistant" &&
            Array.isArray(message.content) &&
            message.content.some(
              (part: Record<string, unknown>) =>
                part.type === "tool" &&
                String(part.name).endsWith("memoir_status") &&
                (part.state as { status?: string } | undefined)?.status === "completed",
            ),
        ) ?? false
      );
    });
    assert.ok(
      Date.now() - started >= 1_500,
      "foreground Memoir call did not wait for the active capture",
    );
  } finally {
    await dispose(h, model);
  }
});

test("shutdown with an active capture finishes inside the native deadline", {
  timeout: TIMEOUT,
}, async () => {
  const model = await startFakeModel({ captureDelayMs: 20_000 });
  let h: OpenCodeHarness | undefined;
  try {
    h = await startOpenCode({ modelUrl: model.url });
    await waitForAdapter(h);
    await waitForMain(h);
    const sessionID = await h.createSession("shutdown");
    await h.prompt(sessionID, "shutdown with active capture");
    await h.waitFor(() => captureRequests(model).length >= 1, 30_000);

    const started = Date.now();
    await h.stop();
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 10_000, `shutdown took ${elapsed} ms`);
    assert.doesNotMatch(h.log(), /shutdown did not finish within 10s/);

    try {
      const result = await exec("pgrep", ["-f", h.store]);
      assert.equal(result.stdout.trim(), "", `memoir-mcp child survived: ${result.stdout}`);
    } catch (error) {
      const code = (error as { code?: number }).code;
      assert.equal(code, 1, "pgrep failed for a reason other than no match");
    }
  } finally {
    await dispose(h, model);
  }
});
