import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { auditMemoirToolParts, extractTurn } from "../../src/capture.js";

const idle = (id: string, outcome = "succeeded") => ({ id, type: "idle", outcome });
const user = (id: string, text: string) => ({ id, type: "user", text });
const assistant = (id: string, text: string) => ({
  id,
  type: "assistant",
  content: [{ type: "text", text }],
});
const tool = (id: string, name: string, status: string) => ({
  id,
  type: "assistant",
  content: [{ type: "tool", name, state: { status } }],
});

describe("exact completed turn", () => {
  it("uses the exact idle and the nearest user before the last assistant text", () => {
    const messages = [
      user("u1", "first"),
      assistant("a1", "answer one"),
      idle("i1"),
      user("u2", "second"),
      assistant("a2", "answer two"),
      idle("i2"),
    ];
    assert.equal(extractTurn(messages, "i2"), "[Human]\nsecond\n\n[Assistant]\nanswer two");
  });

  it("does not fall back to an earlier idle", () => {
    const messages = [user("u1", "first"), assistant("a1", "one"), idle("i1")];
    assert.equal(extractTurn(messages, "missing"), undefined);
  });

  it("ignores tool and reasoning content", () => {
    const messages = [
      user("u1", "q"),
      {
        id: "a1",
        type: "assistant",
        content: [
          { type: "reasoning", text: "hidden" },
          { type: "tool", name: "shell", state: { status: "completed" } },
          { type: "text", text: "visible" },
        ],
      },
      idle("i1"),
    ];
    assert.equal(extractTurn(messages, "i1"), "[Human]\nq\n\n[Assistant]\nvisible");
  });

  it("returns undefined for no user, no assistant text, or empty transcript", () => {
    assert.equal(extractTurn([assistant("a1", "x"), idle("i1")], "i1"), undefined);
    assert.equal(extractTurn([user("u1", "q"), idle("i1")], "i1"), undefined);
    assert.equal(
      extractTurn([user("u1", "   "), assistant("a1", "x"), idle("i1")], "i1"),
      undefined,
    );
  });
});

describe("terminal Memoir tool audit", () => {
  const prefix = "memoir_";

  it("is safe with no Memoir parts", () => {
    assert.equal(auditMemoirToolParts([user("u", "q"), assistant("a", "done")]), false);
  });

  it("is safe only when every Memoir part completed", () => {
    assert.equal(auditMemoirToolParts([tool("t", `${prefix}memoir_remember`, "completed")]), false);
  });

  it("is ambiguous for error, running, streaming, or malformed state", () => {
    for (const status of ["error", "running", "streaming", "missing"]) {
      assert.equal(auditMemoirToolParts([tool("t", `${prefix}memoir_remember`, status)]), true);
    }
    assert.equal(
      auditMemoirToolParts([
        { id: "a", type: "assistant", content: [{ type: "tool", name: `${prefix}x` }] },
      ]),
      true,
    );
  });

  it("ignores another namespace and doom_loop", () => {
    assert.equal(
      auditMemoirToolParts([
        tool("a", "other_memoir_remember", "error"),
        tool("b", "doom_loop", "error"),
        tool("c", "skill", "error"),
      ]),
      false,
    );
  });

  it("is ambiguous for malformed assistant content", () => {
    assert.equal(auditMemoirToolParts([{ id: "a", type: "assistant", content: "bad" }]), true);
  });
});
