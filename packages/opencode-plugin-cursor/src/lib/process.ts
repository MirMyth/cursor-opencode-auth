import { spawn } from "node:child_process";

export type RunResult = {
  code: number;
  stdout: string;
  stderr: string;
};

export type RunOptions = {
  cwd?: string;
  timeoutMs?: number;
};

export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const isWin = process.platform === "win32";
    
    let actualCmd = cmd;
    let actualArgs = args;
    
    if (isWin && (cmd.endsWith(".cmd") || cmd.endsWith(".bat") || cmd === "agent")) {
      actualCmd = process.env.COMSPEC || "cmd.exe";
      actualArgs = ["/d", "/s", "/c", cmd, ...args];
    }
    
    const child = spawn(actualCmd, actualArgs, {
      cwd: opts.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
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

    if (child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
    }

    if (child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
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
