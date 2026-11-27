import { execFileSync } from "node:child_process";

const required = [
  "package.json",
  "README.md",
  "NOTICE.md",
  "LICENSE",
  "dist/index.js",
  "dist/index.d.ts",
  "dist/prompts/capture-system.txt",
  "dist/prompts/onboard-command.txt",
];

const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
});
const packs = JSON.parse(output);
const files = new Set(packs[0]?.files?.map((file) => file.path) ?? []);
const missing = required.filter((file) => !files.has(file));
if (missing.length > 0) {
  console.error("package is missing required files:", missing.join(", "));
  process.exit(1);
}
if ([...files].some((file) => file.startsWith("vendor/") || file.startsWith("src/"))) {
  console.error("package unexpectedly includes build-only sources");
  process.exit(1);
}
console.log(`package contents ok: ${files.size} files`);
