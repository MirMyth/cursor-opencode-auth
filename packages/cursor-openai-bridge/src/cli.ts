import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as http from "node:http";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { URL } from "node:url";

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
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));

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

type CursorCliModel = { id: string; name: string };

function parseCursorCliModels(output: string): CursorCliModel[] {
  const lines = output.split(/\r?\n/g).map((l) => l.trim());
  const models: CursorCliModel[] = [];

  for (const line of lines) {
    const match = line.match(/^([A-Za-z0-9][A-Za-z0-9._:/-]*)\s+-\s+(.*)$/);
    if (!match) continue;
    const id = match[1];
    const rawName = match[2];
    const name = rawName.replace(/\s*\([^)]*\)\s*$/g, "").trim();
    models.push({ id, name: name || id });
  }

  const byId = new Map<string, CursorCliModel>();
  for (const m of models) byId.set(m.id, m);
  return [...byId.values()];
}

function getAgentBin(): string {
  return (
    process.env.CURSOR_AGENT_BIN ||
    process.env.CURSOR_CLI_BIN ||
    process.env.CURSOR_CLI_PATH ||
    "agent"
  );
}

function getHost(): string {
  return process.env.CURSOR_BRIDGE_HOST || "127.0.0.1";
}

function getPort(): number {
  const raw = process.env.CURSOR_BRIDGE_PORT;
  const n = raw ? Number(raw) : 8765;
  return Number.isFinite(n) && n > 0 ? n : 8765;
}

function getRequiredKey(): string | undefined {
  return process.env.CURSOR_BRIDGE_API_KEY;
}

type CursorExecutionMode = "agent" | "ask" | "plan";

function normalizeMode(raw: string | undefined): CursorExecutionMode {
  const m = (raw || "").trim().toLowerCase();
  if (m === "ask" || m === "plan") return m;
  // Cursor CLI does not accept --mode=agent; "agent mode" is the default when --mode is omitted.
  return "agent";
}

function envBool(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw == null) return defaultValue;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return defaultValue;
}

function getWorkspace(): string {
  const raw = process.env.CURSOR_BRIDGE_WORKSPACE;
  return raw ? path.resolve(raw) : process.cwd();
}

function normalizeModelId(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  // Some clients use "provider/model". Cursor CLI expects just "model".
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || undefined;
}

function extractBearerToken(req: http.IncomingMessage): string | undefined {
  const h = req.headers["authorization"];
  if (!h) return undefined;
  const val = Array.isArray(h) ? h[0] : h;
  const match = val.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : undefined;
}

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function messageContentToText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (!p) return "";
        if (typeof p === "string") return p;
        if (p.type === "text" && typeof p.text === "string") return p.text;
        return "";
      })
      .join("");
  }
  return "";
}

function buildPromptFromMessages(messages: any[]): string {
  const systemParts: string[] = [];
  const convo: string[] = [];

  for (const m of messages || []) {
    const role = m?.role;
    const text = messageContentToText(m?.content);
    if (!text) continue;

    if (role === "system" || role === "developer") {
      systemParts.push(text);
      continue;
    }
    if (role === "user") {
      convo.push(`User: ${text}`);
      continue;
    }
    if (role === "assistant") {
      convo.push(`Assistant: ${text}`);
      continue;
    }
    if (role === "tool" || role === "function") {
      convo.push(`Tool: ${text}`);
      continue;
    }
  }

  const system = systemParts.length
    ? `System:\n${systemParts.join("\n\n")}\n\n`
    : "";
  const transcript = convo.join("\n\n");
  return system + transcript + "\n\nAssistant:";
}

type OpenAiChatCompletionRequest = {
  model?: string;
  messages: any[];
  stream?: boolean;
};

async function main() {
  const agentBin = getAgentBin();
  const host = getHost();
  const port = getPort();
  const requiredKey = getRequiredKey();
  const defaultModel = normalizeModelId(process.env.CURSOR_BRIDGE_DEFAULT_MODEL) || "auto";
  const mode = normalizeMode(process.env.CURSOR_BRIDGE_MODE);
  const force = envBool("CURSOR_BRIDGE_FORCE", true);
  const approveMcps = envBool("CURSOR_BRIDGE_APPROVE_MCPS", true);
  const strictModel = envBool("CURSOR_BRIDGE_STRICT_MODEL", true);
  const timeoutMs = Number(process.env.CURSOR_BRIDGE_TIMEOUT_MS || 300_000);

  let modelCache: { at: number; models: CursorCliModel[] } | undefined;
  let lastRequestedModel: string | undefined;

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

      if (requiredKey) {
        const token = extractBearerToken(req);
        if (token !== requiredKey) {
          json(res, 401, { error: { message: "Invalid API key", code: "unauthorized" } });
          return;
        }
      }

      if (req.method === "GET" && url.pathname === "/health") {
        json(res, 200, {
          ok: true,
          version: "0.1.1",
          workspace: getWorkspace(),
          mode,
          defaultModel,
          force,
          approveMcps,
          strictModel,
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/models") {
        const now = Date.now();
        if (!modelCache || now - modelCache.at > 5 * 60_000) {
          const list = await run(agentBin, ["--list-models"], {
            cwd: tmpdir(),
            timeoutMs: 60_000,
          });
          if (list.code !== 0) {
            json(res, 500, {
              error: {
                message: `agent --list-models failed: ${list.stderr.trim()}`,
                code: "cursor_cli_error",
              },
            });
            return;
          }
          modelCache = { at: now, models: parseCursorCliModels(list.stdout) };
        }

        json(res, 200, {
          object: "list",
          data: modelCache.models.map((m) => ({
            id: m.id,
            object: "model",
            owned_by: "cursor",
            name: m.name,
          })),
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        const raw = await readBody(req);
        const body = JSON.parse(raw || "{}") as OpenAiChatCompletionRequest;
        const requested = normalizeModelId(body.model);
        const explicitModel = requested && requested !== "auto" ? requested : undefined;
        if (explicitModel) lastRequestedModel = explicitModel;

        const model =
          explicitModel ||
          (strictModel ? lastRequestedModel : undefined) ||
          requested ||
          lastRequestedModel ||
          defaultModel;
        const prompt = buildPromptFromMessages(body.messages || []);

        const workspace = getWorkspace();
        const cmdArgs: string[] = ["--print"];

        // For non-interactive usage, avoid prompts that would hang the bridge.
        if (approveMcps) cmdArgs.push("--approve-mcps");
        if (force) cmdArgs.push("--force");

        // Cursor CLI only accepts --mode=ask|plan. "agent" is the default when --mode is omitted.
        if (mode !== "agent") cmdArgs.push("--mode", mode);

        cmdArgs.push("--workspace", workspace);
        cmdArgs.push("--model", model);
        cmdArgs.push("--output-format", "text");
        cmdArgs.push(prompt);

        const out = await run(agentBin, cmdArgs, {
          cwd: workspace,
          timeoutMs,
        });
        if (out.code !== 0) {
          json(res, 500, {
            error: {
              message: `Cursor CLI failed (exit ${out.code}): ${out.stderr.trim()}`,
              code: "cursor_cli_error",
            },
          });
          return;
        }

        const content = out.stdout.trim();
        const id = `chatcmpl_${randomUUID().replace(/-/g, "")}`;
        const created = Math.floor(Date.now() / 1000);

        if (body.stream) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });

          const chunk1 = {
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [
              {
                index: 0,
                delta: { role: "assistant", content },
                finish_reason: null,
              },
            ],
          };
          res.write(`data: ${JSON.stringify(chunk1)}\n\n`);
          const chunk2 = {
            id,
            object: "chat.completion.chunk",
            created,
            model,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: "stop",
              },
            ],
          };
          res.write(`data: ${JSON.stringify(chunk2)}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }

        json(res, 200, {
          id,
          object: "chat.completion",
          created,
          model,
          choices: [
            {
              index: 0,
              message: { role: "assistant", content },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });
        return;
      }

      json(res, 404, { error: { message: "Not found", code: "not_found" } });
    } catch (err) {
      json(res, 500, {
        error: {
          message: err instanceof Error ? err.message : String(err),
          code: "internal_error",
        },
      });
    }
  });

  server.listen(port, host, () => {
    // eslint-disable-next-line no-console
    console.log(`cursor-openai-bridge listening on http://${host}:${port}`);
    // eslint-disable-next-line no-console
    console.log(`- agent bin: ${agentBin}`);
    // eslint-disable-next-line no-console
    console.log(`- workspace: ${getWorkspace()}`);
    // eslint-disable-next-line no-console
    console.log(`- mode: ${mode}`);
    // eslint-disable-next-line no-console
    console.log(`- default model: ${defaultModel}`);
    // eslint-disable-next-line no-console
    console.log(`- force: ${force}`);
    // eslint-disable-next-line no-console
    console.log(`- approve mcps: ${approveMcps}`);
    // eslint-disable-next-line no-console
    console.log(`- required api key: ${requiredKey ? "yes" : "no"}`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
