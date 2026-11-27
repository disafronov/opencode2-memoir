import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vendor = join(root, "vendor", "memoir");
const pinned = "0b92609461d8d3ebeacec55ad26d3250b86558e8";
const dist = join(root, "dist");
const prompts = join(dist, "prompts");
const temp = join(dist, ".prompt-build");

function fail(message) {
  throw new Error(`prompt build failed: ${message}`);
}

function runGit(args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0) fail(`git ${args.join(" ")}: ${result.stderr || result.stdout}`);
  return (result.stdout ?? "").trim();
}

function applyPatch(name, cwd) {
  const result = spawnSync("patch", ["--fuzz=0", "-s", "-p1", "-i", join(root, "patches", name)], {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    fail(`${name} did not apply: ${result.stderr || result.stdout}`);
  }
}

function compareTemplate(name, file) {
  const text = readFileSync(file, "utf8");
  if (/\$\{[^}]+\}|\{\{[^}]+\}\}/.test(text)) fail(`${name} has unresolved template placeholders`);
  return text;
}

function validate(name, text, vendorSource) {
  const forbidden = [
    "TAXONOMY_BLOCK",
    "related_keys",
    "CATEGORIES/EXAMPLES",
    "PLUGIN_ROOT",
    "CLAUDE_PLUGIN_ROOT",
    "CODEX_HOME",
    "$MEMOIR",
    "uvx",
    "extractors.py",
    "allowed-tools:",
    "SessionStart",
  ];
  for (const marker of forbidden) {
    if (text.includes(marker)) fail(`${name} contains forbidden marker ${marker}`);
  }
  if (
    /\bmemoir_(get|remember|commits|summarize|checkout|forget|recall|status|branches)\b/.test(text)
  ) {
    fail(`${name} contains a raw Memoir tool identifier; use tool roles`);
  }
  if (/\bTAB\b/.test(text) || /path<TAB>/.test(text) || /Output ONE line/.test(text)) {
    fail(`${name} still contains the upstream line-output protocol`);
  }
  if (/^\s*name:\s*memoir-onboard/m.test(text) || /^\s*allowed-tools:/m.test(text)) {
    fail(`${name} still contains skill frontmatter`);
  }

  const roles = [
    ["Memoir get tool", "memoir_get"],
    ["Memoir remember tool", "memoir_remember"],
    ["Memoir commits tool", "memoir_commits"],
    ["Memoir summarize tool", "memoir_summarize"],
    ["Memoir checkout tool", "memoir_checkout"],
    ["Memoir forget tool", "memoir_forget"],
  ];
  for (const [role, raw] of roles) {
    if (!text.includes(role)) continue;
    if (!vendorSource.includes(`name="${raw}"`)) {
      fail(`${name} uses role "${role}" but Memoir has no ${raw} tool`);
    }
  }
}

try {
  const revision = runGit(["-C", vendor, "rev-parse", "HEAD"]);
  if (revision !== pinned) {
    fail(`vendor/memoir is ${revision}, expected ${pinned}`);
  }

  rmSync(prompts, { recursive: true, force: true });
  rmSync(temp, { recursive: true, force: true });
  mkdirSync(prompts, { recursive: true });
  mkdirSync(join(temp, "plugins", "codex", "skills", "memoir-onboard"), { recursive: true });

  const captureSource = join(vendor, "src", "memoir", "llm", "prompts", "capture_coding.tmpl");
  const onboardSource = join(vendor, "plugins", "codex", "skills", "memoir-onboard", "SKILL.md");
  const serverSource = readFileSync(join(vendor, "src", "memoir", "mcp", "server.py"), "utf8");
  const captureTarget = join(temp, "capture_coding.tmpl");
  const onboardTarget = join(temp, "plugins", "codex", "skills", "memoir-onboard", "SKILL.md");

  cpSync(captureSource, captureTarget);
  cpSync(onboardSource, onboardTarget);
  applyPatch("capture-coding.patch", temp);
  applyPatch("memoir-onboard.patch", temp);

  const capture = compareTemplate("capture prompt", captureTarget);
  const onboard = compareTemplate("onboarding prompt", onboardTarget);
  validate("capture prompt", capture, serverSource);
  validate("onboarding prompt", onboard, serverSource);

  if (!capture.includes("[Human]") || !capture.includes("[Assistant]")) {
    fail("capture prompt does not use the adapter transcript labels");
  }
  if (!onboard.includes("codebase:onboard") || !onboard.includes("project:onboard")) {
    fail("onboarding prompt does not preserve both Memoir namespaces");
  }

  writeFileSync(join(prompts, "capture-system.txt"), capture);
  writeFileSync(join(prompts, "onboard-command.txt"), onboard);
  rmSync(temp, { recursive: true, force: true });
  console.log("prompts: applied upstream patches and validated generated files");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
