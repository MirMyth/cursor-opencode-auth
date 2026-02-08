import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export type RunResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type RunOptions = {
  cwd?: string;
  timeoutMs?: number;
  stdin?: string;
};

// Helper to find the actual node executable for Cursor Agent on Windows to bypass cmd/powershell wrappers
async function resolveWindowsCursorAgent(cmd: string): Promise<{ cmd: string; argsPrefix: string[] } | null> {
  if (process.platform !== "win32") return null;
  if (!cmd.endsWith("agent.cmd") && cmd !== "agent") return null;

  try {
    let agentPath = cmd;
    if (cmd === "agent") {
      // Use 'where' to resolve agent.cmd location from PATH
      const where = spawn("where", ["agent"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
      const out = await new Promise<string>((resolve) => {
        let s = "";
        where.stdout.on("data", c => s += c);
        where.on("close", () => resolve(s.trim().split(/\r?\n/)[0]));
      });
      if (out && out.endsWith("agent.cmd")) {
        agentPath = out;
      } else {
        return null;
      }
    }

    const agentDir = dirname(agentPath);
    const versionsDir = join(agentDir, "versions");

    const entries = await readdir(versionsDir).catch(() => [] as string[]);
    const versions = entries
      .filter(name => /^\d{4}\.\d{1,2}\.\d{1,2}-[a-f0-9]+$/.test(name))
      .sort()
      .reverse();

    if (versions.length > 0) {
      const latest = versions[0];
      const nodeExe = join(versionsDir, latest, "node.exe");
      const script = join(versionsDir, latest, "index.js");
      return { cmd: nodeExe, argsPrefix: [script] };
    }
  } catch (e) {
    // Ignore resolution errors, fall back to default behavior
  }
  return null;
}

export async function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const isWin = process.platform === "win32";
  
  let actualCmd = cmd;
  let actualArgs = args;

  // Optimally resolve Cursor Agent on Windows to avoid cmd/powershell issues
  const resolved = await resolveWindowsCursorAgent(cmd);
  if (resolved) {
    actualCmd = resolved.cmd;
    actualArgs = [...resolved.argsPrefix, ...args];
  } else if (isWin && (cmd.endsWith(".cmd") || cmd.endsWith(".bat") || cmd === "agent")) {
    actualCmd = process.env.COMSPEC || "cmd.exe";
    actualArgs = ["/d", "/s", "/c", cmd, ...args];
  }
  
  return new Promise((resolve, reject) => {
    const child = spawn(actualCmd, actualArgs, {
      cwd: opts.cwd,
      env: process.env,
      stdio: [opts.stdin ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    if (opts.stdin && child.stdin) {
      child.stdin.write(opts.stdin);
      child.stdin.end();
    }

    const timeoutMs = opts.timeoutMs;
    const timeout =
      typeof timeoutMs === "number" && timeoutMs > 0
        ? setTimeout(() => {
            child.kill("SIGKILL");
          }, timeoutMs)
        : undefined;

    let stdout = "";
    let stderr = "";

    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (c) => (stdout += c));
    }
    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (c) => (stderr += c));
    }

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
