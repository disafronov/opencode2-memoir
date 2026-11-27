import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = process.cwd();

describe("generated prompts", () => {
  it("builds from the pinned upstream sources and validates the result", async () => {
    const result = await exec("node", ["scripts/build-prompts.mjs"], { cwd: root });
    assert.match(result.stdout, /validated generated files/);
  });

  it("has no placeholders, raw Memoir tool ids, CLI invocation, or integration markers", async () => {
    const capture = await readFile(join(root, "dist", "prompts", "capture-system.txt"), "utf8");
    const onboard = await readFile(join(root, "dist", "prompts", "onboard-command.txt"), "utf8");
    for (const text of [capture, onboard]) {
      assert.doesNotMatch(text, /\$\{[^}]+\}|\{\{[^}]+\}\}/);
      assert.doesNotMatch(
        text,
        /\bmemoir_(get|remember|commits|summarize|checkout|forget|recall|status|branches)\b/,
      );
      assert.doesNotMatch(
        text,
        /PLUGIN_ROOT|CLAUDE_PLUGIN_ROOT|CODEX_HOME|\$MEMOIR|uvx|extractors\.py|allowed-tools:/,
      );
      assert.doesNotMatch(text, /\bTAB\b|path<TAB>|Output ONE line/);
    }
    assert.match(capture, /Memoir remember tool/);
    assert.match(capture, /Memoir summarize tool/);
    assert.match(capture, /\[Human\]/);
    assert.match(capture, /\[Assistant\]/);
    assert.match(onboard, /codebase:onboard/);
    assert.match(onboard, /project:onboard/);
    assert.match(onboard, /Memoir get tool/);
  });
});
