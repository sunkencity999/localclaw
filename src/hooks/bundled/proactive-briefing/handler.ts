/**
 * Proactive briefing hook handler
 *
 * On gateway startup, reads recent session logs and injects a
 * "Daily Context" section into HEARTBEAT.md so the heartbeat
 * system can deliver context-aware proactive briefings.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "../../../config/config.js";
import type { HookHandler } from "../../hooks.js";
import { resolveAgentWorkspaceDir } from "../../../agents/agent-scope.js";
import { resolveAgentIdFromSessionKey } from "../../../routing/session-key.js";
import { resolveHookConfig } from "../../config.js";

const DEFAULT_MAX_LINES = 20;
const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Extract key lines from a session log file — user questions and topic headers.
 */
function extractKeyLines(content: string, maxLines: number): string[] {
  const lines = content.split("\n");
  const keyLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // Extract turn headers (## Turn at ...)
    if (trimmed.startsWith("## Turn at ")) {
      continue; // Skip raw headers, we'll use the content
    }
    // Extract user messages
    if (trimmed.startsWith("**User:**")) {
      const msg = trimmed.slice("**User:**".length).trim();
      // Skip envelope metadata (timestamps, message IDs)
      const cleaned = msg.replace(/\[.*?\]/g, "").trim();
      if (cleaned.length > 5 && cleaned.length < 200) {
        keyLines.push(`- User asked: "${cleaned}"`);
      }
    }
    // Extract assistant responses (first line only, truncated)
    if (trimmed.startsWith("**Assistant:**")) {
      const msg = trimmed.slice("**Assistant:**".length).trim();
      if (msg.length > 10) {
        const truncated = msg.length > 120 ? msg.slice(0, 117) + "..." : msg;
        keyLines.push(`- Discussed: ${truncated}`);
      }
    }
  }

  // Deduplicate and limit
  const unique = [...new Set(keyLines)];
  return unique.slice(-maxLines);
}

/**
 * Read recent session log files and extract key context.
 */
async function gatherRecentContext(
  sessionsDir: string,
  lookbackMs: number,
  maxLines: number,
): Promise<string[]> {
  try {
    const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
    const now = Date.now();
    const cutoff = now - lookbackMs;
    const allLines: string[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) {
        continue;
      }
      const filePath = path.join(sessionsDir, entry.name);
      const stat = await fs.stat(filePath);
      if (stat.mtimeMs < cutoff) {
        continue;
      }
      const content = await fs.readFile(filePath, "utf-8");
      const lines = extractKeyLines(content, maxLines);
      allLines.push(...lines);
    }

    // Return the most recent lines, deduplicated
    const unique = [...new Set(allLines)];
    return unique.slice(-maxLines);
  } catch {
    return [];
  }
}

const injectProactiveBriefing: HookHandler = async (event) => {
  if (event.type !== "gateway" || event.action !== "startup") {
    return;
  }

  try {
    const context = event.context || {};
    const cfg = context.cfg as OpenClawConfig | undefined;
    const agentId = resolveAgentIdFromSessionKey(event.sessionKey || "agent:main:main");
    const workspaceDir = cfg
      ? resolveAgentWorkspaceDir(cfg, agentId)
      : path.join(os.homedir(), ".openclaw", "workspace");
    const sessionsDir = path.join(workspaceDir, "memory", "sessions");
    const briefingPath = path.join(workspaceDir, "memory", "briefing-context.md");

    // Read hook config
    const hookConfig = resolveHookConfig(cfg, "proactive-briefing");
    const maxLines =
      typeof hookConfig?.maxLines === "number" && hookConfig.maxLines > 0
        ? hookConfig.maxLines
        : DEFAULT_MAX_LINES;
    const lookbackMs =
      typeof hookConfig?.lookbackMs === "number" && hookConfig.lookbackMs > 0
        ? hookConfig.lookbackMs
        : DEFAULT_LOOKBACK_MS;

    // Gather recent session context
    const contextLines = await gatherRecentContext(sessionsDir, lookbackMs, maxLines);

    if (contextLines.length === 0) {
      // No recent context — remove stale briefing file
      try {
        await fs.rm(briefingPath, { force: true });
      } catch {
        // File doesn't exist — nothing to clean
      }
      return;
    }

    // Build the briefing file (standalone, not injected into HEARTBEAT.md)
    const now = new Date();
    const dateStr = now.toISOString().split("T")[0];
    const content = [
      `# Daily Briefing (auto-generated ${dateStr})`,
      "",
      "Recent session activity (last 24h):",
      ...contextLines,
      "",
    ].join("\n");

    await fs.mkdir(path.dirname(briefingPath), { recursive: true });
    await fs.writeFile(briefingPath, content, "utf-8");
    console.log(
      `[proactive-briefing] Wrote ${contextLines.length} context lines to memory/briefing-context.md`,
    );
  } catch (err) {
    console.error(
      "[proactive-briefing] Failed to inject briefing:",
      err instanceof Error ? err.message : String(err),
    );
  }
};

export default injectProactiveBriefing;
