import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { Plugin } from "@opencode/plugin";
import { ensureStore, hashStore, resolveStore, runMemoir, slug } from "../../src/store.js";
import { type FakeMemoir, installFakeMemoir } from "./fake-cli.js";

let fake: FakeMemoir | undefined;
afterEach(async () => {
  await fake?.restore();
  fake = undefined;
});

function ctxFor(canonical: string, options: Record<string, unknown> = {}): Plugin.Context {
  return {
    location: { directory: canonical, project: { canonical, directory: canonical, id: "p" } },
    options,
  } as unknown as Plugin.Context;
}

describe("store identity", () => {
  it("slug replaces only slash and dot", () => {
    assert.equal(slug("/home/me/.memoir"), "-home-me--memoir");
  });

  it("hash is stable and 16 hex characters", () => {
    const first = hashStore("/tmp/project");
    assert.equal(first, hashStore("/tmp/project"));
    assert.match(first, /^[0-9a-f]{16}$/);
  });

  it("option override wins over env", async () => {
    const previous = process.env.MEMOIR_STORE;
    process.env.MEMOIR_STORE = "/tmp/from-env";
    try {
      const storePath = resolveStore(ctxFor("/tmp/project", { store: "/tmp/from-option" }));
      assert.equal(storePath, "/tmp/from-option");
    } finally {
      if (previous === undefined) delete process.env.MEMOIR_STORE;
      else process.env.MEMOIR_STORE = previous;
    }
  });

  it("env wins over project fallback", async () => {
    const previous = process.env.MEMOIR_STORE;
    process.env.MEMOIR_STORE = "/tmp/from-env";
    try {
      assert.equal(resolveStore(ctxFor("/tmp/project")), "/tmp/from-env");
    } finally {
      if (previous === undefined) delete process.env.MEMOIR_STORE;
      else process.env.MEMOIR_STORE = previous;
    }
  });

  it("fallback uses the canonical project path", async () => {
    const previous = process.env.MEMOIR_STORE;
    delete process.env.MEMOIR_STORE;
    try {
      const canonical = await mkdtemp(join(tmpdir(), "memoir-canonical-"));
      try {
        const storePath = resolveStore(ctxFor(canonical));
        assert.match(storePath, /\.memoir[/\\]/);
        assert.ok(storePath.includes(slug(canonical)));
      } finally {
        await rm(canonical, { recursive: true, force: true });
      }
    } finally {
      if (previous !== undefined) process.env.MEMOIR_STORE = previous;
    }
  });
});

describe("Memoir CLI invocation", () => {
  it("runs new and checkout with the expected arguments, cwd, and store", async () => {
    fake = await installFakeMemoir();
    const store = "/tmp/memoir-store-test";
    const result = await runMemoir(["--json", "new", store], "/tmp", store);
    assert.equal(result.code, 0);
    const output = await fake.calls();
    assert.ok(output.includes("--json"));
    assert.ok(output.includes("new"));
    assert.ok(output.includes(store));
    assert.ok(output.includes("store:/tmp/memoir-store-test"));
  });

  it("does not call memoir new for an already initialized store", async () => {
    fake = await installFakeMemoir();
    const store = await mkdtemp(join(tmpdir(), "memoir-existing-"));
    try {
      await mkdir(join(store, ".git"));
      const result = await ensureStore(store);
      assert.equal(result, store);
      assert.deepEqual(await fake.calls(), []);
    } finally {
      await rm(store, { recursive: true, force: true });
    }
  });

  it("returns non-zero exit codes without retrying", async () => {
    fake = await installFakeMemoir();
    fake.setExit(5);
    const result = await runMemoir(["--json", "checkout", "-b", "feature"], "/tmp", "/tmp/store");
    assert.equal(result.code, 5);
    assert.deepEqual(await fake.calls(), [
      "--json",
      "checkout",
      "-b",
      "feature",
      "cwd:/tmp",
      "store:/tmp/store",
    ]);
  });
});
