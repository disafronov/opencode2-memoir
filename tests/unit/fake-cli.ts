// biome-ignore-all lint/suspicious/noTemplateCurlyInString: shell parameter expansion is intentional in this fixture
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type FakeMemoir = {
  dir: string;
  log: string;
  restore: () => Promise<void>;
  setExit: (code: number) => void;
  setSleep: (seconds: number) => void;
  calls: () => Promise<string[]>;
};

/** Install a disposable `memoir` executable at the front of PATH. */
export async function installFakeMemoir(): Promise<FakeMemoir> {
  const dir = await mkdtemp(join(tmpdir(), "memoir-fake-"));
  const log = join(dir, "calls.log");
  const script = join(dir, "memoir");
  await writeFile(
    script,
    [
      "#!/bin/sh",
      'printf "%s\\n" "$@" >> "$MEMOIR_FAKE_LOG"',
      'printf "cwd:%s\\n" "$PWD" >> "$MEMOIR_FAKE_LOG"',
      'printf "store:%s\\n" "${MEMOIR_STORE:-}" >> "$MEMOIR_FAKE_LOG"',
      'if [ -n "${MEMOIR_FAKE_SLEEP:-}" ]; then sleep "$MEMOIR_FAKE_SLEEP"; fi',
      'exit "${MEMOIR_FAKE_EXIT:-0}"',
      "",
    ].join("\n"),
  );
  await chmod(script, 0o755);

  const previousPath = process.env.PATH;
  const previousLog = process.env.MEMOIR_FAKE_LOG;
  const previousExit = process.env.MEMOIR_FAKE_EXIT;
  const previousSleep = process.env.MEMOIR_FAKE_SLEEP;
  process.env.PATH = `${dir}:${previousPath ?? ""}`;
  process.env.MEMOIR_FAKE_LOG = log;
  process.env.MEMOIR_FAKE_EXIT = "0";

  return {
    dir,
    log,
    restore: async () => {
      process.env.PATH = previousPath;
      if (previousLog === undefined) delete process.env.MEMOIR_FAKE_LOG;
      else process.env.MEMOIR_FAKE_LOG = previousLog;
      if (previousExit === undefined) delete process.env.MEMOIR_FAKE_EXIT;
      else process.env.MEMOIR_FAKE_EXIT = previousExit;
      if (previousSleep === undefined) delete process.env.MEMOIR_FAKE_SLEEP;
      else process.env.MEMOIR_FAKE_SLEEP = previousSleep;
      await rm(dir, { recursive: true, force: true });
    },
    setExit: (code: number) => {
      process.env.MEMOIR_FAKE_EXIT = String(code);
    },
    setSleep: (seconds: number) => {
      process.env.MEMOIR_FAKE_SLEEP = String(seconds);
    },
    calls: async () => {
      try {
        return (await readFile(log, "utf8")).trim().split("\n").filter(Boolean);
      } catch {
        return [];
      }
    },
  };
}
