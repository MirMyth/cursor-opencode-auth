import type { Plugin } from "@opencode-ai/plugin";

import { stat } from "node:fs/promises";
import * as path from "node:path";

import { ensureBridgeProcess } from "./lib/bridge.js";
import { ensurePluginShowsVersionInStatus } from "./lib/pluginShim.js";
import { createBridgeTools } from "./tools/bridge.js";
import { createCliTools } from "./tools/cli.js";
import { createCloudTools } from "./tools/cloud.js";

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

function looksLikeTempDir(p: string): boolean {
  const normalized = path.resolve(p);
  if (normalized.includes(`${path.sep}T${path.sep}`)) return true;
  if (normalized.includes("cursor-openai-bridge-")) return true;
  if (normalized.includes("cursor-opencode-worktree-")) return true;
  return false;
}

async function resolveWorkspaceRoot(args: { directory?: string; worktree?: string }): Promise<string> {
  const preferred = [args.worktree, args.directory].filter(
    (v): v is string => typeof v === "string" && v.trim().length > 0,
  );
  for (const cand of preferred) {
    const resolved = path.resolve(cand);
    if (await isDirectory(resolved)) return resolved;
  }

  const envCandidates = [
    process.env.OPENCODE_DIRECTORY,
    process.env.OPENCODE_WORKSPACE,
    process.env.INIT_CWD,
    process.env.PWD,
  ].filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  for (const cand of envCandidates) {
    const resolved = path.resolve(cand);
    if (looksLikeTempDir(resolved)) continue;
    if (await isDirectory(resolved)) return resolved;
  }

  throw new Error(
    "Could not determine a real workspace directory (got a temp cwd). " +
      "Set CURSOR_BRIDGE_WORKSPACE to your project path, or ensure OpenCode passes directory/worktree to the plugin.",
  );
}

function getCursorAgentBin(): string {
  return (
    process.env.CURSOR_AGENT_BIN ||
    process.env.CURSOR_CLI_BIN ||
    process.env.CURSOR_CLI_PATH ||
    "agent"
  );
}

export const CursorPlugin: Plugin = async ({ client, directory, worktree }) => {
  const agentBin = getCursorAgentBin();
  const cwd = await resolveWorkspaceRoot({ directory, worktree });
  const repoRoot = worktree || undefined;

  // Make /status show this plugin version by ensuring a versioned plugin shim exists.
  // OpenCode only shows versions for npm plugins; for local file plugins it displays the file name.
  // This is best-effort and takes effect after restarting OpenCode.
  await ensurePluginShowsVersionInStatus(client).catch(() => undefined);

  // Ensure the Cursor OpenAI-compatible bridge process is running.
  await ensureBridgeProcess(agentBin, cwd);

  return {
    tool: {
      ...createBridgeTools({ agentBin, cwd }),
      ...createCliTools({ agentBin, cwd, repoRoot }),
      ...createCloudTools({ cwd }),
    },
  };
};
