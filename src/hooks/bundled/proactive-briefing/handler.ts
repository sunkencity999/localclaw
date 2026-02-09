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

const SECTION_START = "<!-- proactive-briefing:start -->";
const SECTION_END = "<!-- proactive-briefing:end -->";
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

/**
 * Replace or append the managed section in HEARTBEAT.md.
 */
function updateHeartbeatContent(existing: string, contextSection: string): string {
  const startIdx = existing.indexOf(SECTION_START);
  const endIdx = existing.indexOf(SECTION_END);

  if (startIdx !== -1 && endIdx !== -1) {
    // Replace existing section
    return (
      existing.slice(0, startIdx) + contextSection + existing.slice(endIdx + SECTION_END.length)
    );
  }

  // Append new section
  const separator = existing.trim().length > 0 ? "\n\n" : "";
  return existing.trimEnd() + separator + contextSection + "\n";
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
    const heartbeatPath = path.join(workspaceDir, "HEARTBEAT.md");

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
      // No recent context — clean up any stale section
      try {
        const existing = await fs.readFile(heartbeatPath, "utf-8");
        if (existing.includes(SECTION_START)) {
          const cleaned = updateHeartbeatContent(existing, "");
          await fs.writeFile(heartbeatPath, cleaned, "utf-8");
          console.log("[proactive-briefing] Cleared stale context section");
        }
      } catch {
        // File doesn't exist or can't be read — nothing to clean
      }
      return;
    }

    // Build the context section
    const now = new Date();
    const dateStr = now.toISOString().split("T")[0];
    const section = [
      SECTION_START,
      `## Daily Context (auto-generated ${dateStr})`,
      "",
      "Recent session activity (last 24h):",
      ...contextLines,
      SECTION_END,
    ].join("\n");

    // Read existing HEARTBEAT.md or start fresh
    let existing = "";
    try {
      existing = await fs.readFile(heartbeatPath, "utf-8");
    } catch {
      // File doesn't exist — will be created
    }

    const updated = updateHeartbeatContent(existing, section);
    await fs.writeFile(heartbeatPath, updated, "utf-8");
    console.log(
      `[proactive-briefing] Injected ${contextLines.length} context lines into HEARTBEAT.md`,
    );
  } catch (err) {
    console.error(
      "[proactive-briefing] Failed to inject briefing:",
      err instanceof Error ? err.message : String(err),
    );
  }
};

export default injectProactiveBriefing;
