import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCaptureModel, resolveCaptureModel } from "../../src/model.js";

describe("capture model parsing", () => {
  it("parses provider/model and provider/model:variant", () => {
    assert.deepEqual(parseCaptureModel("openai/gpt-5"), {
      id: "gpt-5",
      providerID: "openai",
    });
    assert.deepEqual(parseCaptureModel("openai/gpt-5:low"), {
      id: "gpt-5",
      providerID: "openai",
      variant: "low",
    });
  });

  it("trims surrounding whitespace", () => {
    assert.deepEqual(parseCaptureModel("  anthropic/claude-haiku-4-5  "), {
      id: "claude-haiku-4-5",
      providerID: "anthropic",
    });
  });

  it("rejects bare, empty, extra-slash, and extra-colon values", () => {
    for (const value of [
      "",
      "   ",
      "gpt-5",
      "/gpt-5",
      "openai/",
      "openai/gpt-5/extra",
      "openai/gpt-5:low:x",
    ]) {
      assert.equal(parseCaptureModel(value), undefined, value);
    }
  });

  it("rejects whitespace inside provider, model, or variant", () => {
    for (const value of ["open ai/gpt-5", "openai/gpt 5", "openai/gpt-5:low weight"]) {
      assert.equal(parseCaptureModel(value), undefined, value);
    }
  });
});

describe("capture model resolution", () => {
  const sessionModel = { id: "session-model", providerID: "session" };

  it("uses an explicit override before the active session model", () => {
    assert.deepEqual(resolveCaptureModel("override/fast", sessionModel), {
      id: "fast",
      providerID: "override",
    });
  });

  it("uses the active session model when no override is set", () => {
    assert.deepEqual(resolveCaptureModel(undefined, sessionModel), sessionModel);
    assert.deepEqual(resolveCaptureModel("   ", sessionModel), sessionModel);
  });

  it("lets OpenCode choose the default when both sources are absent", () => {
    assert.equal(resolveCaptureModel(undefined, undefined), undefined);
  });

  it("warns and falls back when the override is malformed", () => {
    const warnings: string[] = [];
    const resolved = resolveCaptureModel("bare-model", sessionModel, (message) =>
      warnings.push(message),
    );
    assert.deepEqual(resolved, sessionModel);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /MEMOIR_AGENT_MODEL/);
  });
});
