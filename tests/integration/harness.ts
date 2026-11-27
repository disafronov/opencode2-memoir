import { type ChildProcess, execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { hashStore, safeRealpath } from "../../src/store.js";

const exec = promisify(execFile);

export type ModelRequest = {
  n: number;
  model?: string;
  isCapture: boolean;
  isForeground: boolean;
  toolNames: string[];
  lastRole?: string;
  texts: string;
};

export type FakeModel = {
  url: string;
  requests: ModelRequest[];
  close: () => Promise<void>;
};

export type FakeModelOptions = {
  captureDelayMs?: number;
  failAfterTool?: boolean;
  capturePath?: string;
  captureContent?: string;
};

function sseChunk(model: string, delta: unknown, finish: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "fake-completion",
    object: "chat.completion.chunk",
    created: 1,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
}

/** Deterministic OpenAI-compatible SSE endpoint. */
export async function startFakeModel(options: FakeModelOptions = {}): Promise<FakeModel> {
  const requests: ModelRequest[] = [];
  const server: Server = createServer(async (request, response) => {
    if (!request.url?.includes("/chat/completions")) {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    let body: {
      model?: string;
      messages?: Array<{
        role?: string;
        content?: string | Array<{ type?: string; text?: string }>;
      }>;
      tools?: Array<{ function?: { name?: string } }>;
    } = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      body = {};
    }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const texts = messages
      .map((message) =>
        typeof message.content === "string"
          ? message.content
          : Array.isArray(message.content)
            ? message.content.map((part) => part?.text ?? "").join("")
            : "",
      )
      .join("\n");
    const toolNames = (body.tools ?? [])
      .map((tool) => tool?.function?.name)
      .filter((name): name is string => typeof name === "string");
    const isCapture = texts.includes("[Human]") && texts.includes("[Assistant]");
    const isForeground = texts.includes("[FOREGROUND]");
    const last = messages.at(-1);
    const record: ModelRequest = {
      n: requests.length + 1,
      model: body.model,
      isCapture,
      isForeground,
      toolNames,
      lastRole: last?.role,
      texts,
    };
    requests.push(record);

    if (options.captureDelayMs && isCapture && last?.role !== "tool") {
      await new Promise((resolve) => setTimeout(resolve, options.captureDelayMs));
    }
    if (options.failAfterTool && isCapture && last?.role === "tool") {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "forced capture failure" } }));
      return;
    }

    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const emit = (delta: unknown, finish: string | null = null) =>
      response.write(sseChunk(body.model ?? "fake", delta, finish));
    emit({ role: "assistant" });

    const remember = toolNames.find((name) => name.endsWith("memoir_remember"));
    const status = toolNames.find((name) => name.endsWith("memoir_status"));
    if (isCapture && last?.role !== "tool" && remember) {
      emit({
        tool_calls: [
          {
            index: 0,
            id: "call_remember",
            type: "function",
            function: {
              name: remember,
              arguments: JSON.stringify({
                content: options.captureContent ?? "The project uses a deterministic capture path.",
                path: options.capturePath ?? "test.capture.fact",
                merge_policy: "replace",
              }),
            },
          },
        ],
      });
      emit({}, "tool_calls");
    } else if (isForeground && last?.role !== "tool" && status) {
      emit({
        tool_calls: [
          {
            index: 0,
            id: "call_status",
            type: "function",
            function: { name: status, arguments: "{}" },
          },
        ],
      });
      emit({}, "tool_calls");
    } else if (isCapture) {
      emit({ content: "capture complete" });
      emit({}, "stop");
    } else {
      emit({ content: "ACK from deterministic model" });
      emit({}, "stop");
    }
    response.end("data: [DONE]\n\n");
  });

  const port = await freePort();
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

export async function freePort(): Promise<number> {
  const server = createTcpServer();
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

export type OpenCodeHarness = {
  root: string;
  project: string;
  store: string;
  api: <T = unknown>(path: string, init?: RequestInit) => Promise<T>;
  createSession: (title: string) => Promise<string>;
  prompt: (sessionID: string, text: string) => Promise<void>;
  context: (sessionID: string) => Promise<Array<Record<string, unknown>>>;
  sessions: () => Promise<Array<Record<string, unknown>>>;
  mcp: () => Promise<Array<Record<string, unknown>>>;
  agents: () => Promise<Array<Record<string, unknown>>>;
  git: (...args: string[]) => Promise<string>;
  status: () => Promise<Record<string, unknown> | undefined>;
  get: (key: string) => Promise<boolean>;
  waitFor: (predicate: () => boolean | Promise<boolean>, timeout?: number) => Promise<void>;
  stop: (
    signal?: NodeJS.Signals,
  ) => Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  log: () => string;
};

export type OpenCodeOptions = {
  modelUrl: string;
  path?: string;
  userMcp?: boolean;
  collideWithAdapter?: boolean;
  store?: string;
  env?: Record<string, string>;
};

function opencodeBin(): string {
  const value = process.env.OPENCODE_BIN;
  if (!value) throw new Error("OPENCODE_BIN is required for integration tests");
  return value;
}

function authHeader(): string {
  return `Basic ${Buffer.from("opencode:testpass").toString("base64")}`;
}

async function waitForReady(base: string, child: ChildProcess, log: () => string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 30_000) {
    if (child.exitCode !== null) throw new Error(`OpenCode exited early:\n${log()}`);
    try {
      const response = await fetch(`${base}/api/config`, {
        headers: { authorization: authHeader() },
      });
      if (response.status === 200) return;
    } catch {
      // server not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`OpenCode did not become ready:\n${log()}`);
}

/** Start a real OpenCode 2.4.1 server with this plugin and a temporary Git project. */
export async function startOpenCode(options: OpenCodeOptions): Promise<OpenCodeHarness> {
  const root = await mkdtemp(join(tmpdir(), "opencode2-memoir-it-"));
  const project = join(root, "project");
  const store = options.store ?? join(root, "store");
  await mkdir(project, { recursive: true });
  await exec("git", ["init", "-q", "-b", "main"], { cwd: project });
  await exec("git", ["config", "user.email", "it@example.com"], { cwd: project });
  await exec("git", ["config", "user.name", "Integration"], { cwd: project });
  await writeFile(join(project, "README.md"), "# integration project\n");
  await exec("git", ["add", "README.md"], { cwd: project });
  await exec("git", ["commit", "-q", "-m", "initial"], { cwd: project });

  const configDir = join(root, "config");
  const xdg = join(root, "xdg");
  await mkdir(configDir, { recursive: true });
  await mkdir(join(xdg, "config"), { recursive: true });
  await mkdir(join(xdg, "data"), { recursive: true });
  await mkdir(join(xdg, "cache"), { recursive: true });
  await mkdir(join(xdg, "state"), { recursive: true });
  const configPath = join(configDir, "opencode.json");
  const collisionName = `memoir_plugin_${hashStore(safeRealpath(store))}`;
  const config = {
    $schema: "https://opencode.ai/config.json",
    plugins: [process.cwd()],
    model: "probe/fake",
    provider: {
      probe: {
        npm: "@ai-sdk/openai-compatible",
        name: "Probe Local",
        options: { baseURL: options.modelUrl, apiKey: "local" },
        models: {
          fake: { name: "Fake", limit: { context: 32_000, output: 1024 } },
        },
      },
    },
    ...(options.userMcp || options.collideWithAdapter
      ? {
          mcp: {
            ...(options.userMcp
              ? {
                  memoir: {
                    type: "local",
                    command: ["sleep", "60"],
                    disabled: false,
                  },
                }
              : {}),
            ...(options.collideWithAdapter
              ? {
                  [collisionName]: {
                    type: "local",
                    command: ["sleep", "60"],
                    disabled: false,
                  },
                }
              : {}),
          },
        }
      : {}),
  };
  await writeFile(configPath, JSON.stringify(config, null, 2));

  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  let logs = "";
  const child = spawn(
    opencodeBin(),
    ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs"],
    {
      cwd: project,
      env: {
        ...process.env,
        XDG_CONFIG_HOME: join(xdg, "config"),
        XDG_DATA_HOME: join(xdg, "data"),
        XDG_CACHE_HOME: join(xdg, "cache"),
        XDG_STATE_HOME: join(xdg, "state"),
        OPENCODE_CONFIG: configPath,
        OPENCODE_CONFIG_DIR: configDir,
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
        OPENCODE_DISABLE_AUTOUPDATE: "1",
        OPENCODE_DISABLE_MODELS_FETCH: "1",
        OPENCODE_SERVER_PASSWORD: "testpass",
        MEMOIR_STORE: store,
        PATH: options.path ?? process.env.PATH ?? "",
        ...options.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.on("data", (chunk) => {
    logs += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    logs += chunk.toString();
  });
  await waitForReady(base, child, () => logs);

  const api = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(`${base}${path}`, {
      ...init,
      headers: {
        authorization: authHeader(),
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
    });
    if (!response.ok) {
      throw new Error(
        `${init?.method ?? "GET"} ${path}: ${response.status} ${await response.text()}`,
      );
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  };

  const createSession = async (title: string): Promise<string> => {
    const result = await api<{ data: { id: string } }>("/api/session", {
      method: "POST",
      body: JSON.stringify({ title }),
    });
    return result.data.id;
  };

  const prompt = async (sessionID: string, text: string): Promise<void> => {
    await api(`/api/session/${sessionID}/prompt`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
  };

  const context = async (sessionID: string) => {
    const result = await api<
      Array<Record<string, unknown>> | { data: Array<Record<string, unknown>> }
    >(`/api/session/${sessionID}/context`);
    return Array.isArray(result) ? result : result.data;
  };

  const sessions = async () => {
    const result = await api<{ data: Array<Record<string, unknown>> }>("/api/session?limit=100");
    return result.data;
  };

  const mcp = async () => {
    const result = await api<{ data: Array<Record<string, unknown>> }>("/api/mcp");
    return result.data;
  };

  const agents = async () => {
    const result = await api<{ data: Array<Record<string, unknown>> }>("/api/agent");
    return result.data;
  };

  const git = async (...args: string[]) => {
    const result = await exec("git", args, { cwd: project, encoding: "utf8" });
    return result.stdout.trim();
  };

  const status = async (): Promise<Record<string, unknown> | undefined> => {
    try {
      const result = await exec("memoir", ["-s", store, "--json", "status"], {
        cwd: store,
        encoding: "utf8",
      });
      return JSON.parse(result.stdout) as Record<string, unknown>;
    } catch {
      return undefined;
    }
  };

  const get = async (key: string): Promise<boolean> => {
    try {
      const result = await exec("memoir", ["-s", store, "--json", "get", key, "-n", "default"], {
        cwd: store,
        encoding: "utf8",
      });
      const parsed = JSON.parse(result.stdout) as { found_count?: number };
      return (parsed.found_count ?? 0) > 0;
    } catch {
      return false;
    }
  };

  const waitFor = async (
    predicate: () => boolean | Promise<boolean>,
    timeout = 30_000,
  ): Promise<void> => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`condition timed out:\n${logs}`);
  };

  const stop = async (signal: NodeJS.Signals = "SIGTERM") => {
    if (child.exitCode !== null) return { code: child.exitCode, signal: null };
    child.kill(signal);
    const code = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.once("exit", (exitCode, exitSignal) =>
          resolve({ code: exitCode, signal: exitSignal }),
        );
      },
    );
    return code;
  };

  return {
    root,
    project,
    store,
    api,
    createSession,
    prompt,
    context,
    sessions,
    mcp,
    agents,
    git,
    status,
    get,
    waitFor,
    stop,
    log: () => logs,
  };
}

/** Install a test-only memoir-mcp shim that returns an error and writes later. */
export async function installAmbiguousMcp(): Promise<{
  dir: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "memoir-ambiguous-"));
  const binDir = join(dir, "bin");
  await mkdir(binDir, { recursive: true });
  const realMcp = process.env.MEMOIR_MCP_BIN ?? "memoir-mcp";
  const probe = await exec("sh", ["-c", `command -v ${realMcp}`], { encoding: "utf8" });
  const mcpPath = probe.stdout.trim();
  const firstLine = (await readFile(mcpPath, "utf8")).split("\n", 1)[0] ?? "";
  const python = process.env.MEMOIR_PYTHON ?? firstLine.replace(/^#!\s*/, "").trim();
  if (!python) throw new Error("could not resolve the Memoir MCP Python interpreter");

  const wrapper = join(dir, "ambiguous.py");
  await writeFile(
    wrapper,
    `import asyncio, json, os, threading, time
import memoir.mcp.server as server

LOG = os.environ.get("AMBIENT_LOG", "/tmp/ambient.log")
DELAY = float(os.environ.get("AMBIENT_DELAY", "3"))
_orig = server.remember

def log(event, **fields):
    with open(LOG, "a", encoding="utf-8") as handle:
        handle.write(json.dumps({"t": time.time(), "event": event, **fields}) + "\\n")

async def fail_then_write(*args, **kwargs):
    log("remember-start")
    def late():
        time.sleep(DELAY)
        try:
            asyncio.run(_orig(*args, **kwargs))
            log("remember-done")
        except BaseException as error:
            log("remember-error", errorType=type(error).__name__, error=str(error)[:300])
    threading.Thread(target=late, daemon=True).start()
    raise RuntimeError("injected MCP failure after starting the real write")

server.remember = fail_then_write
log("server-start")
server.main()
`,
  );
  const shim = join(binDir, "memoir-mcp");
  await writeFile(shim, `#!/bin/sh\nexec "${python}" "${wrapper}" "$@"\n`);
  await chmod(shim, 0o755);
  return {
    dir: binDir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}
