import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { Plugin } from "@opencode/plugin";

const execFileAsync = promisify(execFile);

/** Resolve a path through symlinks, falling back to the input on failure. */
export function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** Turn an absolute project path into a stable filesystem-safe store name. */
export function slug(path: string): string {
  return path.replace(/[/.]/g, "-");
}

/** Resolve the project store from options, env, or the canonical project path. */
export function resolveStore(ctx: Plugin.Context): string {
  const option = ctx.options?.store;
  const override = typeof option === "string" && option.trim() ? option.trim() : undefined;
  const env = process.env.MEMOIR_STORE?.trim() || undefined;
  const canonical = safeRealpath(ctx.location.project.canonical);
  const storePath = resolve(
    override ?? env ?? join(homedir(), ".memoir", slug(safeRealpath(canonical))),
  );
  return storePath;
}

export type CliResult = {
  code: number;
  stdout: string;
  stderr: string;
};

/** Run the Memoir CLI without a shell and without an adapter timeout. */
export async function runMemoir(
  args: string[],
  cwd: string,
  storePath?: string,
): Promise<CliResult> {
  const env = storePath ? { ...process.env, MEMOIR_STORE: storePath } : process.env;
  try {
    const result = await execFileAsync("memoir", args, {
      cwd,
      env,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  } catch (error) {
    const value = error as {
      code?: number | string;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      message?: string;
    };
    return {
      code: typeof value.code === "number" ? value.code : 1,
      stdout: value.stdout?.toString() ?? "",
      stderr: value.stderr?.toString() ?? value.message ?? String(error),
    };
  }
}

/** Create the store idempotently. The store already lives at the configured path. */
export async function ensureStore(storePath: string): Promise<string> {
  // Memoir's own MCP server treats an existing .git directory as an already
  // initialized store. `memoir new` refuses a store with commits, so do not
  // call it again on restart or on a reused store override.
  if (existsSync(join(storePath, ".git"))) return safeRealpath(storePath);
  const created = await runMemoir(["--json", "new", storePath], dirname(storePath));
  if (created.code !== 0) {
    throw new Error(`memoir new failed for ${storePath}: ${created.stderr || created.stdout}`);
  }
  return safeRealpath(storePath);
}

/** Switch/create the Memoir branch from the current store HEAD. */
export async function checkoutBranch(storePath: string, branch: string): Promise<CliResult> {
  return runMemoir(["--json", "checkout", "-b", branch], storePath, storePath);
}
