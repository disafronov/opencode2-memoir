import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { capabilities } from "../../src/state.js";

const all = {
  mcpReady: true,
  agentReady: true,
  contextReady: true,
  guardReady: true,
  eventReady: true,
  capturePromptReady: true,
  onboardPromptReady: true,
};

describe("dependent capabilities", () => {
  it("enables everything only when every required capture dependency is present", () => {
    assert.deepEqual(capabilities(all), {
      branchSyncEnabled: true,
      captureEnabled: true,
      onboardEnabled: true,
    });
  });

  it("a missing guard disables automatic branch changes, capture, and onboarding", () => {
    assert.deepEqual(capabilities({ ...all, guardReady: false }), {
      branchSyncEnabled: false,
      captureEnabled: false,
      onboardEnabled: false,
    });
  });

  it("a missing event subscription disables automatic behavior", () => {
    assert.deepEqual(capabilities({ ...all, eventReady: false }), {
      branchSyncEnabled: false,
      captureEnabled: false,
      onboardEnabled: false,
    });
  });

  it("missing capture components disable only capture", () => {
    for (const key of ["agentReady", "contextReady", "capturePromptReady"] as const) {
      assert.deepEqual(capabilities({ ...all, [key]: false }), {
        branchSyncEnabled: true,
        captureEnabled: false,
        onboardEnabled: true,
      });
    }
  });

  it("missing MCP disables capture/onboarding but leaves CLI-only branch sync", () => {
    assert.deepEqual(capabilities({ ...all, mcpReady: false }), {
      branchSyncEnabled: true,
      captureEnabled: false,
      onboardEnabled: false,
    });
  });

  it("a missing onboarding prompt disables only onboarding", () => {
    assert.deepEqual(capabilities({ ...all, onboardPromptReady: false }), {
      branchSyncEnabled: true,
      captureEnabled: true,
      onboardEnabled: false,
    });
  });
});
