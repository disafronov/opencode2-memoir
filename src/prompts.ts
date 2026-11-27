import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Load a generated prompt shipped in dist/prompts. */
function loadPrompt(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./prompts/${name}`, import.meta.url)), "utf8");
}

export function loadCapturePrompt(): string {
  return loadPrompt("capture-system.txt");
}

export function loadOnboardPrompt(): string {
  return loadPrompt("onboard-command.txt");
}
