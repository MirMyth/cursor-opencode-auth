import { spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";

type RunResult = {
  code: number;
  stdout: string;
  stderr: string;
};

type RunOptions = {
  cwd?: string;
  timeoutMs?: number;
};

function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timeoutMs = opts.timeoutMs;
    const timeout =
      typeof timeoutMs === "number" && timeoutMs > 0
        ? setTimeout(() => {
            child.kill("SIGKILL");
          }, timeoutMs)
        : undefined;

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (timeout) clearTimeout(timeout);
      if (err?.code === "ENOENT") {
        reject(
          new Error(
            `Command not found: ${cmd}. Install Cursor CLI (agent) or set CURSOR_AGENT_BIN to its path.`,
          ),
        );
        return;
      }
      reject(err);
    });
    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      resolve({ code: code ?? 0, stdout, stderr });
    });
  });
}

function parseModelList(output: string): string[] {
  // Cursor CLI output format is not guaranteed; keep this permissive.
  // Common cases:
  // - one model per line
  // - bullet lists
  const lines = output
    .split(/\r?\n/g)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.replace(/^[-*]\s+/, ""))
    .filter(Boolean);

  const looksLikeModelID = (s: string) =>
    /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(s);

  return lines.filter(looksLikeModelID);
}

type CursorApiAuthStyle = "basic" | "bearer";

function getCursorAgentBin(): string {
  return (
    process.env.CURSOR_AGENT_BIN ||
    process.env.CURSOR_CLI_BIN ||
    process.env.CURSOR_CLI_PATH ||
    "agent"
  );
}

const OPENCODE_PLUGIN_DISPLAY_NAME = "cursor-opencode-auth";
let cachedSelfVersion: string | undefined;

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function getOpencodePluginsDir(): string | undefined {
  const xdg = process.env.XDG_CONFIG_HOME;
  const home = process.env.HOME;
  const configHome = xdg || (home ? path.join(home, ".config") : undefined);
  if (!configHome) return undefined;
  return path.join(configHome, "opencode", "plugins");
}

async function getSelfVersion(): Promise<string | undefined> {
  if (cachedSelfVersion) return cachedSelfVersion;
  try {
    // Works for both local dev (`src/`) and built (`dist/`) entrypoints.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkgJsonPath = path.resolve(here, "../package.json");
    const raw = await readFile(pkgJsonPath, "utf8");
    const pkg = JSON.parse(raw) as { version?: unknown };
    const version = typeof pkg?.version === "string" ? pkg.version : undefined;
    cachedSelfVersion = version;
    return version;
  } catch {
    return undefined;
  }
}

async function getSelfEntrypointPath(): Promise<string> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pkgRoot = path.resolve(here, "..");
  const distEntry = path.join(pkgRoot, "dist", "index.js");
  if (await fileExists(distEntry)) return distEntry;
  const srcEntry = path.join(pkgRoot, "src", "index.ts");
  if (await fileExists(srcEntry)) return srcEntry;
  return fileURLToPath(import.meta.url);
}

function isReExportShimFile(text: string): boolean {
  return /export\s+\{\s*CursorPlugin\s*\}\s+from\s+["']/.test(text);
}

async function ensurePluginShowsVersionInStatus(
  client: any,
): Promise<{ changed: boolean; targetName?: string } | undefined> {
  const version = await getSelfVersion();
  if (!version) return;

  const pluginsDir = getOpencodePluginsDir();
  if (!pluginsDir) return;

  const base = OPENCODE_PLUGIN_DISPLAY_NAME;
  const versionedStem = `${base}@${version}`;
  const versionedTs = path.join(pluginsDir, `${versionedStem}.ts`);
  const versionedJs = path.join(pluginsDir, `${versionedStem}.js`);

  // Already versioned.
  if ((await fileExists(versionedTs)) || (await fileExists(versionedJs))) return;

  await mkdir(pluginsDir, { recursive: true });

  // Prefer renaming an existing shim to avoid duplicates.
  const candidates: string[] = [
    path.join(pluginsDir, `${base}.ts`),
    path.join(pluginsDir, `${base}.js`),
  ];

  try {
    const entries = await readdir(pluginsDir);
    for (const name of entries) {
      if (!name.startsWith(`${base}@`)) continue;
      if (!(name.endsWith(".ts") || name.endsWith(".js"))) continue;
      candidates.push(path.join(pluginsDir, name));
    }
  } catch {
    // ignore
  }

  for (const cand of candidates) {
    if (!(await fileExists(cand))) continue;
    const ext = cand.endsWith(".js") ? "js" : cand.endsWith(".ts") ? "ts" : undefined;
    if (!ext) continue;

    const text = await readFile(cand, "utf8").catch(() => "");
    if (text && !isReExportShimFile(text)) continue;

    const target = path.join(pluginsDir, `${versionedStem}.${ext}`);
    if (cand === target) return;
    try {
      await rename(cand, target);
      return { changed: true, targetName: path.basename(target, path.extname(target)) };
    } catch {
      // try next candidate
    }
  }

  // No existing shim found; create a versioned shim file.
  const entryPath = await getSelfEntrypointPath();
  const shim = `// Auto-generated by ${base} v${version}\nexport { CursorPlugin } from ${JSON.stringify(entryPath)};\n`;
  await writeFile(versionedTs, shim, "utf8");

  // Best-effort: remove other versioned shims that are simple re-exports.
  try {
    const entries = await readdir(pluginsDir);
    await Promise.all(
      entries.map(async (name) => {
        if (!name.startsWith(`${base}@`)) return;
        if (name === `${versionedStem}.ts` || name === `${versionedStem}.js`) return;
        if (!(name.endsWith(".ts") || name.endsWith(".js"))) return;
        const full = path.join(pluginsDir, name);
        const text = await readFile(full, "utf8").catch(() => "");
        if (!text || !isReExportShimFile(text)) return;
        await unlink(full).catch(() => undefined);
      }),
    );
  } catch {
    // ignore
  }

  // Optional UX: toast that a restart is needed to refresh /status.
  try {
    await client?.tui?.showToast?.({
      body: {
        title: base,
        message: `Installed versioned plugin entry (${versionedStem}). Restart OpenCode to see it in /status.`,
        variant: "success",
        duration: 6_000,
      },
    });
  } catch {
    // ignore
  }

  return { changed: true, targetName: versionedStem };
}

// --- Cursor Bridge (external process) ---

function getBridgeHost(): string {
  return process.env.CURSOR_BRIDGE_HOST || "127.0.0.1";
}

function getBridgePort(): number {
  const raw = process.env.CURSOR_BRIDGE_PORT;
  const n = raw ? Number(raw) : 8765;
  return Number.isFinite(n) && n > 0 ? n : 8765;
}

function getBridgeBaseURL(): string {
  return `http://${getBridgeHost()}:${getBridgePort()}`;
}

function getBridgeHealthURL(): string {
  return `${getBridgeBaseURL()}/health`;
}

function shouldAutostartBridge(): boolean {
  const raw = process.env.CURSOR_BRIDGE_AUTOSTART;
  if (!raw) return true;
  return !(raw === "0" || raw.toLowerCase() === "false");
}

function getBridgeScriptPath(): string | undefined {
  const envPath = process.env.CURSOR_OPENAI_BRIDGE_SCRIPT;
  if (envPath) return envPath;

  // Local monorepo default: packages/cursor-openai-bridge/dist/cli.js
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidate = path.resolve(
    here,
    "../../cursor-openai-bridge/dist/cli.js",
  );
  return candidate;
}

function getBridgePidPath(): string {
  const home = process.env.HOME || tmpdir();
  return path.join(home, ".local", "share", "opencode", "cursor-openai-bridge.pid");
}

async function isBridgeUp(timeoutMs = 500): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(getBridgeHealthURL(), { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function startBridgeDetached(
  agentBin: string,
  workspace?: string,
): Promise<number> {
  const script = getBridgeScriptPath();
  if (!script) {
    throw new Error(
      "CURSOR_OPENAI_BRIDGE_SCRIPT is not set and default bridge script path could not be resolved.",
    );
  }

  const nodeBin = process.env.CURSOR_BRIDGE_NODE_BIN || "node";
  const child = spawn(nodeBin, [script], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      CURSOR_AGENT_BIN: agentBin,
      ...(workspace && !process.env.CURSOR_BRIDGE_WORKSPACE
        ? { CURSOR_BRIDGE_WORKSPACE: workspace }
        : {}),
    },
  });

  if (!child.pid) {
    throw new Error("Failed to spawn cursor-openai-bridge (no pid)");
  }

  child.unref();

  const pidPath = getBridgePidPath();
  await mkdir(path.dirname(pidPath), { recursive: true });
  await writeFile(pidPath, String(child.pid), "utf8");
  return child.pid;
}

async function stopBridgeByPidFile(): Promise<boolean> {
  const pidPath = getBridgePidPath();
  try {
    const raw = await readFile(pidPath, "utf8");
    const pid = Number(raw.trim());
    if (!Number.isFinite(pid) || pid <= 0) {
      await unlink(pidPath);
      return false;
    }

    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // ignore
    }

    await unlink(pidPath);
    return true;
  } catch {
    return false;
  }
}

async function ensureBridgeProcess(agentBin: string, workspace?: string) {
  if (!shouldAutostartBridge()) return;
  if (await isBridgeUp()) return;
  try {
    await startBridgeDetached(agentBin, workspace);

    const start = Date.now();
    while (Date.now() - start < 3_000) {
      if (await isBridgeUp(300)) return;
      await new Promise((r) => setTimeout(r, 200));
    }
  } catch {
    // Best-effort. If it fails, the provider will error when used.
  }
}

function getCursorApiBaseURL(): string {
  return process.env.CURSOR_API_BASE_URL || "https://api.cursor.com";
}

function getCursorApiKey(explicit?: string): string {
  const key = explicit || process.env.CURSOR_API_KEY;
  if (!key) {
    throw new Error(
      "Missing Cursor API key. Set CURSOR_API_KEY or pass apiKey explicitly.",
    );
  }
  return key;
}

function buildAuthHeader(key: string, style: CursorApiAuthStyle): string {
  if (style === "bearer") return `Bearer ${key}`;
  // Basic auth, as documented by Cursor APIs and Cloud Agents API.
  return `Basic ${Buffer.from(`${key}:`).toString("base64")}`;
}

async function cursorApiRequest<T>(args: {
  method: "GET" | "POST" | "DELETE";
  path: string;
  apiKey?: string;
  authStyle?: CursorApiAuthStyle;
  baseURL?: string;
  body?: unknown;
  timeoutMs?: number;
}): Promise<T> {
  const baseURL = (args.baseURL || getCursorApiBaseURL()).replace(/\/$/, "");
  const apiKey = getCursorApiKey(args.apiKey);
  const authStyle = args.authStyle ?? "basic";

  const controller = new AbortController();
  const timeout =
    typeof args.timeoutMs === "number" && args.timeoutMs > 0
      ? setTimeout(() => controller.abort(), args.timeoutMs)
      : undefined;

  try {
    const res = await fetch(`${baseURL}${args.path}`, {
      method: args.method,
      headers: {
        Authorization: buildAuthHeader(apiKey, authStyle),
        "Content-Type": "application/json",
      },
      body: args.body ? JSON.stringify(args.body) : undefined,
      signal: controller.signal,
    });

    const contentType = res.headers.get("content-type") || "";
    const isJson = contentType.includes("application/json");

    if (!res.ok) {
      const text = isJson ? JSON.stringify(await res.json()) : await res.text();
      const suffix =
        res.status === 401
          ? " (auth failed: verify CURSOR_API_KEY)"
          : res.status === 429
            ? " (rate limited)"
            : "";
      throw new Error(
        `Cursor API ${args.method} ${args.path} failed: ${res.status} ${res.statusText}${suffix}\n${text}`,
      );
    }

    if (res.status === 204) return undefined as T;
    if (isJson) return (await res.json()) as T;
    return (await res.text()) as unknown as T;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function toBase64(data: Uint8Array): string {
  return Buffer.from(data).toString("base64");
}

export const CursorPlugin: Plugin = async ({ client, directory, worktree }) => {
  const agentBin = getCursorAgentBin();

  const cwd = directory || process.cwd();
  const repoRoot = worktree || undefined;

  // Make /status show this plugin version by ensuring a versioned plugin shim exists.
  // OpenCode only shows versions for npm plugins; for local file plugins it displays the file name.
  // This is best-effort and takes effect after restarting OpenCode.
  await ensurePluginShowsVersionInStatus(client).catch(() => undefined);

  // Ensure the Cursor OpenAI-compatible bridge process is running.
  await ensureBridgeProcess(agentBin, cwd);

  return {
    tool: {
      cursor_bridge_status: tool({
        description:
          "Check whether the local cursor-openai-bridge is reachable (GET /health).",
        args: {},
        async execute() {
          const ok = await isBridgeUp(500);
          return JSON.stringify(
            {
              ok,
              baseURL: getBridgeBaseURL(),
              v1BaseURL: `${getBridgeBaseURL()}/v1`,
              healthURL: getBridgeHealthURL(),
            },
            null,
            2,
          );
        },
      }),

      cursor_bridge_start: tool({
        description:
          "Start the local cursor-openai-bridge as a detached process (if not already running).",
        args: {},
        async execute() {
          if (await isBridgeUp(300)) {
            return JSON.stringify(
              {
                ok: true,
                alreadyRunning: true,
                baseURL: getBridgeBaseURL(),
                v1BaseURL: `${getBridgeBaseURL()}/v1`,
              },
              null,
              2,
            );
          }

          const pid = await startBridgeDetached(agentBin, cwd);

          // Wait briefly for it to come up.
          const start = Date.now();
          while (Date.now() - start < 5_000) {
            if (await isBridgeUp(300)) {
              return JSON.stringify(
                {
                  ok: true,
                  pid,
                  baseURL: getBridgeBaseURL(),
                  v1BaseURL: `${getBridgeBaseURL()}/v1`,
                },
                null,
                2,
              );
            }
            await new Promise((r) => setTimeout(r, 250));
          }

          return JSON.stringify(
            {
              ok: false,
              pid,
              message:
                "Started process but /health did not respond yet. Check logs by running the bridge manually.",
            },
            null,
            2,
          );
        },
      }),

      cursor_bridge_stop: tool({
        description:
          "Stop the local cursor-openai-bridge using the pid file (best-effort).",
        args: {},
        async execute() {
          const stopped = await stopBridgeByPidFile();
          return JSON.stringify(
            {
              stopped,
              ok: !(await isBridgeUp(300)),
            },
            null,
            2,
          );
        },
      }),

      cursor_cli_status: tool({
        description: "Show Cursor CLI authentication/status (agent status).",
        args: {
          timeoutMs: tool.schema
            .number()
            .int()
            .positive()
            .optional()
            .describe("Timeout in ms for the Cursor CLI call (optional)"),
        },
        async execute(args) {
          const res = await run(agentBin, ["status"], {
            cwd,
            timeoutMs: args.timeoutMs ?? 60_000,
          });
          if (res.code !== 0) {
            throw new Error(
              `Cursor CLI status failed (exit ${res.code}).\n${res.stderr.trim()}`,
            );
          }
          return res.stdout.trim();
        },
      }),

      cursor_cli_models: tool({
        description:
          "List all models available to Cursor CLI (agent --list-models).",
        args: {
          // Keep args empty for now; future: `raw`, `filter`, etc.
        },
        async execute() {
          const res = await run(agentBin, ["--list-models"], {
            cwd,
            timeoutMs: 60_000,
          });
          if (res.code !== 0) {
            const hint =
              res.stderr.includes("Not authenticated") ||
              res.stderr.toLowerCase().includes("login")
                ? "Try: agent login (browser auth) or set CURSOR_API_KEY"
                : "";
            throw new Error(
              `Failed to run Cursor CLI (agent --list-models). ${hint}\n` +
                `stderr: ${res.stderr.trim()}`,
            );
          }

          const models = parseModelList(res.stdout);
          if (models.length === 0) {
            throw new Error(
              "Cursor CLI returned no models. Try running: agent --list-models",
            );
          }

          return JSON.stringify({ models }, null, 2);
        },
      }),

      cursor_cli_run: tool({
        description:
          "Run Cursor CLI (agent) in --print mode and return the final text.",
        args: {
          prompt: tool.schema.string().describe("Prompt to send to Cursor CLI"),
          mode: tool.schema
            .enum(["ask", "plan", "agent"])
            .optional()
            .describe("Cursor CLI mode (default: ask)"),
          model: tool.schema
            .string()
            .optional()
            .describe("Cursor model ID (optional, e.g. gpt-5.2)"),
          outputFormat: tool.schema
            .enum(["text", "json"])
            .optional()
            .describe("Cursor CLI output format (default: text)"),
          force: tool.schema
            .boolean()
            .optional()
            .describe(
              "If true, passes --force. This can enable writes/commands in print mode; use Cursor CLI permissions to constrain.",
            ),
          timeoutMs: tool.schema
            .number()
            .int()
            .positive()
            .optional()
            .describe("Timeout in ms for the Cursor CLI call (optional)"),
        },
        async execute(args) {
          const mode = args.mode ?? "ask";
          const outputFormat = args.outputFormat ?? "text";
          const force = args.force ?? false;

          const cmdArgs: string[] = ["--print"];

          // Cursor CLI only accepts --mode=ask|plan. "agent" is the default when --mode is omitted.
          if (mode !== "agent") {
            cmdArgs.push("--mode", mode);
          }

          cmdArgs.push("--output-format", outputFormat);

          if (args.model) {
            cmdArgs.push("--model", args.model);
          }

          if (force) {
            cmdArgs.push("--force");
          }

          cmdArgs.push(args.prompt);

          const res = await run(agentBin, cmdArgs, {
            cwd,
            timeoutMs: args.timeoutMs,
          });
          if (res.code !== 0) {
            throw new Error(
              `Cursor CLI failed (exit ${res.code}).\n` +
                `stderr: ${res.stderr.trim()}`,
            );
          }

          return res.stdout.trim();
        },
      }),

      cursor_cli_patch: tool({
        description:
          "Run Cursor CLI in an isolated git worktree and return a unified diff patch.",
        args: {
          prompt: tool.schema
            .string()
            .describe("Task prompt. Cursor will apply changes inside a temp worktree."),
          model: tool.schema
            .string()
            .optional()
            .describe("Cursor model ID (optional, e.g. gpt-5.2)"),
          mode: tool.schema
            .enum(["agent", "plan", "ask"])
            .optional()
            .describe("Cursor CLI mode (default: agent)")
            .default("agent"),
          allowDirty: tool.schema
            .boolean()
            .optional()
            .describe(
              "If true, runs even when the main repo has uncommitted changes (not recommended).",
            ),
          keepTemp: tool.schema
            .boolean()
            .optional()
            .describe(
              "If true, do not remove temp worktree directory (for debugging).",
            ),
          timeoutMs: tool.schema
            .number()
            .int()
            .positive()
            .optional()
            .describe("Timeout in ms for the Cursor CLI call (optional)"),
        },
        async execute(args) {
          if (!repoRoot) {
            throw new Error(
              "cursor_cli_patch requires a git repository (no worktree detected).",
            );
          }

          const allowDirty = args.allowDirty ?? false;
          const keepTemp = args.keepTemp ?? false;
          const mode = args.mode ?? "agent";

          // Enforce clean working tree by default for correct patching.
          const status = await run("git", ["status", "--porcelain"], {
            cwd: repoRoot,
            timeoutMs: 30_000,
          });

          if (status.code !== 0) {
            throw new Error(
              `git status failed.\n${status.stderr.trim() || status.stdout.trim()}`,
            );
          }

          if (!allowDirty && status.stdout.trim().length > 0) {
            throw new Error(
              "Working tree is not clean. Commit/stash changes (or pass allowDirty=true).",
            );
          }

          const tempBase = await mkdtemp(
            path.join(tmpdir(), "cursor-opencode-worktree-"),
          );
          const tempDir = tempBase;

          try {
            // Create detached worktree from current HEAD.
            const wtAdd = await run(
              "git",
              ["worktree", "add", "--detach", tempDir, "HEAD"],
              { cwd: repoRoot, timeoutMs: 60_000 },
            );

            if (wtAdd.code !== 0) {
              throw new Error(
                `git worktree add failed.\n${wtAdd.stderr.trim() || wtAdd.stdout.trim()}`,
              );
            }

            const cmdArgs: string[] = [
              "--print",
              "--force",
              "--output-format",
              "text",
            ];
            // Cursor CLI only accepts --mode=ask|plan. "agent" is the default when --mode is omitted.
            if (mode !== "agent") cmdArgs.push("--mode", mode);
            if (args.model) cmdArgs.push("--model", args.model);
            cmdArgs.push(args.prompt);

            const cursorRes = await run(agentBin, cmdArgs, {
              cwd: tempDir,
              timeoutMs: args.timeoutMs,
            });

            if (cursorRes.code !== 0) {
              throw new Error(
                `Cursor CLI failed inside worktree (exit ${cursorRes.code}).\n` +
                  `stderr: ${cursorRes.stderr.trim()}`,
              );
            }

            // Include untracked files in diff.
            const addIntent = await run("git", ["add", "-N", "."], {
              cwd: tempDir,
              timeoutMs: 60_000,
            });
            if (addIntent.code !== 0) {
              throw new Error(
                `git add -N failed.\n${addIntent.stderr.trim() || addIntent.stdout.trim()}`,
              );
            }

            const diff = await run("git", ["diff", "--patch", "--binary"], {
              cwd: tempDir,
              timeoutMs: 60_000,
            });

            if (diff.code !== 0) {
              throw new Error(
                `git diff failed.\n${diff.stderr.trim() || diff.stdout.trim()}`,
              );
            }

            const nameStatus = await run(
              "git",
              ["diff", "--name-status"],
              { cwd: tempDir, timeoutMs: 60_000 },
            );

            const patchText = diff.stdout.trimEnd();
            const summary =
              nameStatus.code === 0 ? nameStatus.stdout.trim() : "";

            if (!patchText) {
              return [
                "<cursor_cli_patch>",
                "<message>Cursor completed, but produced no git diff (no changes).</message>",
                summary ? `<summary>\n${summary}\n</summary>` : "",
                cursorRes.stdout.trim()
                  ? `<cursor_stdout>\n${cursorRes.stdout.trim()}\n</cursor_stdout>`
                  : "",
                cursorRes.stderr.trim()
                  ? `<cursor_stderr>\n${cursorRes.stderr.trim()}\n</cursor_stderr>`
                  : "",
                "</cursor_cli_patch>",
              ]
                .filter(Boolean)
                .join("\n");
            }

            return [
              "<cursor_cli_patch>",
              summary ? `<summary>\n${summary}\n</summary>` : "",
              cursorRes.stdout.trim()
                ? `<cursor_stdout>\n${cursorRes.stdout.trim()}\n</cursor_stdout>`
                : "",
              cursorRes.stderr.trim()
                ? `<cursor_stderr>\n${cursorRes.stderr.trim()}\n</cursor_stderr>`
                : "",
              "<patch>",
              patchText,
              "</patch>",
              "</cursor_cli_patch>",
            ]
              .filter(Boolean)
              .join("\n");
          } finally {
            if (!keepTemp) {
              // Remove worktree entry; may need force due to modifications.
              const rmRes = await run(
                "git",
                ["worktree", "remove", tempDir],
                { cwd: repoRoot, timeoutMs: 60_000 },
              );
              if (rmRes.code !== 0) {
                await run("git", ["worktree", "remove", "--force", tempDir], {
                  cwd: repoRoot,
                  timeoutMs: 60_000,
                });
              }
              await rm(tempDir, { recursive: true, force: true });
            }
          }
        },
      }),

      cursor_cloud_models: tool({
        description:
          "List recommended models for Cursor Cloud Agents (GET /v0/models).",
        args: {
          apiKey: tool.schema
            .string()
            .optional()
            .describe("Cursor API key (optional; defaults to CURSOR_API_KEY)"),
          authStyle: tool.schema
            .enum(["basic", "bearer"])
            .optional()
            .describe("Auth style (default: basic)")
            .default("basic"),
          baseURL: tool.schema
            .string()
            .optional()
            .describe("Override base URL (default: https://api.cursor.com)"),
        },
        async execute(args) {
          const data = await cursorApiRequest<{ models: string[] }>({
            method: "GET",
            path: "/v0/models",
            apiKey: args.apiKey,
            authStyle: args.authStyle,
            baseURL: args.baseURL,
            timeoutMs: 60_000,
          });
          return JSON.stringify(data, null, 2);
        },
      }),

      cursor_cloud_launch_agent: tool({
        description:
          "Launch a Cursor Cloud Agent (POST /v0/agents). Returns agent id + URLs.",
        args: {
          apiKey: tool.schema
            .string()
            .optional()
            .describe("Cursor API key (optional; defaults to CURSOR_API_KEY)"),
          authStyle: tool.schema
            .enum(["basic", "bearer"])
            .optional()
            .describe("Auth style (default: basic)")
            .default("basic"),
          baseURL: tool.schema
            .string()
            .optional()
            .describe("Override base URL (default: https://api.cursor.com)"),
          prompt: tool.schema.string().describe("Agent prompt text"),
          images: tool.schema
            .array(
              tool.schema.object({
                path: tool.schema.string().optional(),
                data: tool.schema.string().optional(),
                width: tool.schema.number().int().positive().optional(),
                height: tool.schema.number().int().positive().optional(),
              }),
            )
            .optional()
            .describe(
              "Optional images. Provide either {data: base64} or {path: ./file.png}.",
            ),
          model: tool.schema
            .string()
            .optional()
            .describe("Optional model name (otherwise Cursor auto-selects)"),
          repository: tool.schema
            .string()
            .optional()
            .describe(
              "Git repository URL (required unless prUrl is provided), e.g. https://github.com/org/repo",
            ),
          ref: tool.schema
            .string()
            .optional()
            .describe("Git ref (branch/tag/sha), e.g. main"),
          prUrl: tool.schema
            .string()
            .optional()
            .describe("GitHub PR URL (optional; if set, repository/ref ignored)"),
          target: tool.schema
            .object({
              autoCreatePr: tool.schema.boolean().optional(),
              openAsCursorGithubApp: tool.schema.boolean().optional(),
              skipReviewerRequest: tool.schema.boolean().optional(),
              branchName: tool.schema.string().optional(),
              autoBranch: tool.schema.boolean().optional(),
            })
            .optional()
            .describe("Optional target options"),
          webhook: tool.schema
            .object({
              url: tool.schema.string(),
              secret: tool.schema.string().optional(),
            })
            .optional()
            .describe("Optional webhook config"),
        },
        async execute(args) {
          const images = args.images
            ? await Promise.all(
                args.images.map(async (img) => {
                  if (img.data) {
                    return {
                      data: img.data,
                      dimension:
                        img.width && img.height
                          ? { width: img.width, height: img.height }
                          : undefined,
                    };
                  }

                  if (!img.path) {
                    throw new Error(
                      "Each image must include either data (base64) or path.",
                    );
                  }

                  const buf = await readFile(path.resolve(cwd, img.path));
                  return {
                    data: toBase64(buf),
                    dimension:
                      img.width && img.height
                        ? { width: img.width, height: img.height }
                        : undefined,
                  };
                }),
              )
            : undefined;

          const body: any = {
            prompt: {
              text: args.prompt,
              ...(images ? { images } : {}),
            },
            source: {},
          };

          if (args.model) body.model = args.model;
          if (args.target) body.target = args.target;
          if (args.webhook) body.webhook = args.webhook;

          if (args.prUrl) {
            body.source.prUrl = args.prUrl;
          } else {
            if (!args.repository) {
              throw new Error("repository is required unless prUrl is provided");
            }
            body.source.repository = args.repository;
            if (args.ref) body.source.ref = args.ref;
          }

          const data = await cursorApiRequest({
            method: "POST",
            path: "/v0/agents",
            apiKey: args.apiKey,
            authStyle: args.authStyle,
            baseURL: args.baseURL,
            body,
            timeoutMs: 120_000,
          });

          return JSON.stringify(data, null, 2);
        },
      }),

      cursor_cloud_agent: tool({
        description: "Get a Cursor Cloud Agent status (GET /v0/agents/{id}).",
        args: {
          id: tool.schema.string().describe("Agent id (e.g. bc_abc123)"),
          apiKey: tool.schema.string().optional(),
          authStyle: tool.schema
            .enum(["basic", "bearer"])
            .optional()
            .default("basic"),
          baseURL: tool.schema.string().optional(),
        },
        async execute(args) {
          const data = await cursorApiRequest({
            method: "GET",
            path: `/v0/agents/${encodeURIComponent(args.id)}`,
            apiKey: args.apiKey,
            authStyle: args.authStyle,
            baseURL: args.baseURL,
            timeoutMs: 60_000,
          });
          return JSON.stringify(data, null, 2);
        },
      }),

      cursor_cloud_conversation: tool({
        description:
          "Fetch a Cursor Cloud Agent conversation (GET /v0/agents/{id}/conversation).",
        args: {
          id: tool.schema.string().describe("Agent id (e.g. bc_abc123)"),
          apiKey: tool.schema.string().optional(),
          authStyle: tool.schema
            .enum(["basic", "bearer"])
            .optional()
            .default("basic"),
          baseURL: tool.schema.string().optional(),
        },
        async execute(args) {
          const data = await cursorApiRequest({
            method: "GET",
            path: `/v0/agents/${encodeURIComponent(args.id)}/conversation`,
            apiKey: args.apiKey,
            authStyle: args.authStyle,
            baseURL: args.baseURL,
            timeoutMs: 60_000,
          });
          return JSON.stringify(data, null, 2);
        },
      }),

      cursor_cloud_followup: tool({
        description:
          "Send a follow-up to a Cursor Cloud Agent (POST /v0/agents/{id}/followup).",
        args: {
          id: tool.schema.string().describe("Agent id (e.g. bc_abc123)"),
          prompt: tool.schema.string().describe("Follow-up prompt text"),
          apiKey: tool.schema.string().optional(),
          authStyle: tool.schema
            .enum(["basic", "bearer"])
            .optional()
            .default("basic"),
          baseURL: tool.schema.string().optional(),
        },
        async execute(args) {
          const data = await cursorApiRequest({
            method: "POST",
            path: `/v0/agents/${encodeURIComponent(args.id)}/followup`,
            apiKey: args.apiKey,
            authStyle: args.authStyle,
            baseURL: args.baseURL,
            body: { prompt: { text: args.prompt } },
            timeoutMs: 60_000,
          });
          return JSON.stringify(data, null, 2);
        },
      }),

      cursor_cloud_stop: tool({
        description: "Stop a Cursor Cloud Agent (POST /v0/agents/{id}/stop).",
        args: {
          id: tool.schema.string().describe("Agent id (e.g. bc_abc123)"),
          apiKey: tool.schema.string().optional(),
          authStyle: tool.schema
            .enum(["basic", "bearer"])
            .optional()
            .default("basic"),
          baseURL: tool.schema.string().optional(),
        },
        async execute(args) {
          const data = await cursorApiRequest({
            method: "POST",
            path: `/v0/agents/${encodeURIComponent(args.id)}/stop`,
            apiKey: args.apiKey,
            authStyle: args.authStyle,
            baseURL: args.baseURL,
            timeoutMs: 60_000,
          });
          return JSON.stringify(data, null, 2);
        },
      }),

      cursor_cloud_delete: tool({
        description:
          "Delete a Cursor Cloud Agent (DELETE /v0/agents/{id}). Permanent.",
        args: {
          id: tool.schema.string().describe("Agent id (e.g. bc_abc123)"),
          apiKey: tool.schema.string().optional(),
          authStyle: tool.schema
            .enum(["basic", "bearer"])
            .optional()
            .default("basic"),
          baseURL: tool.schema.string().optional(),
        },
        async execute(args) {
          const data = await cursorApiRequest({
            method: "DELETE",
            path: `/v0/agents/${encodeURIComponent(args.id)}`,
            apiKey: args.apiKey,
            authStyle: args.authStyle,
            baseURL: args.baseURL,
            timeoutMs: 60_000,
          });
          return JSON.stringify(data, null, 2);
        },
      }),

      cursor_cloud_me: tool({
        description: "Get API key info (GET /v0/me).",
        args: {
          apiKey: tool.schema.string().optional(),
          authStyle: tool.schema
            .enum(["basic", "bearer"])
            .optional()
            .default("basic"),
          baseURL: tool.schema.string().optional(),
        },
        async execute(args) {
          const data = await cursorApiRequest({
            method: "GET",
            path: "/v0/me",
            apiKey: args.apiKey,
            authStyle: args.authStyle,
            baseURL: args.baseURL,
            timeoutMs: 60_000,
          });
          return JSON.stringify(data, null, 2);
        },
      }),

      cursor_cloud_agents: tool({
        description: "List Cursor Cloud Agents (GET /v0/agents).",
        args: {
          apiKey: tool.schema.string().optional(),
          authStyle: tool.schema
            .enum(["basic", "bearer"])
            .optional()
            .default("basic"),
          baseURL: tool.schema.string().optional(),
          limit: tool.schema
            .number()
            .int()
            .positive()
            .max(100)
            .optional()
            .describe("Max results (default: 20, max: 100)"),
          cursor: tool.schema
            .string()
            .optional()
            .describe("Pagination cursor from prior response"),
          prUrl: tool.schema
            .string()
            .optional()
            .describe("Filter agents by PR URL"),
        },
        async execute(args) {
          const params = new URLSearchParams();
          if (args.limit) params.set("limit", String(args.limit));
          if (args.cursor) params.set("cursor", args.cursor);
          if (args.prUrl) params.set("prUrl", args.prUrl);

          const data = await cursorApiRequest({
            method: "GET",
            path: `/v0/agents${params.size ? `?${params.toString()}` : ""}`,
            apiKey: args.apiKey,
            authStyle: args.authStyle,
            baseURL: args.baseURL,
            timeoutMs: 60_000,
          });
          return JSON.stringify(data, null, 2);
        },
      }),

      cursor_cloud_repositories: tool({
        description:
          "List GitHub repositories available to Cursor Cloud Agents (GET /v0/repositories). Strict rate limits.",
        args: {
          apiKey: tool.schema.string().optional(),
          authStyle: tool.schema
            .enum(["basic", "bearer"])
            .optional()
            .default("basic"),
          baseURL: tool.schema.string().optional(),
        },
        async execute(args) {
          const data = await cursorApiRequest({
            method: "GET",
            path: "/v0/repositories",
            apiKey: args.apiKey,
            authStyle: args.authStyle,
            baseURL: args.baseURL,
            timeoutMs: 120_000,
          });
          return JSON.stringify(data, null, 2);
        },
      }),
    },
  };
};
