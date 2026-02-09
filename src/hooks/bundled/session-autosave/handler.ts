/**
 * Session auto-save hook handler
 *
 * Appends a brief log of each agent turn to a dated session log file
 * in the workspace memory directory. This preserves context that would
 * otherwise be lost during compaction.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "../../../config/config.js";
import type { HookHandler } from "../../hooks.js";
import { resolveAgentWorkspaceDir } from "../../../agents/agent-scope.js";
import { resolveAgentIdFromSessionKey } from "../../../routing/session-key.js";
import { resolveHookConfig } from "../../config.js";

/**
 * Extract the last N user/assistant messages from a session transcript file.
 */
async function getLastMessages(
  sessionFilePath: string,
  count: number,
): Promise<Array<{ role: string; text: string }>> {
  try {
    const content = await fs.readFile(sessionFilePath, "utf-8");
    const lines = content.trim().split("\n");
    const messages: Array<{ role: string; text: string }> = [];

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === "message" && entry.message) {
          const msg = entry.message;
          const role = msg.role;
          if ((role === "user" || role === "assistant") && msg.content) {
            const text = Array.isArray(msg.content)
              ? // oxlint-disable-next-line typescript/no-explicit-any
                msg.content.find((c: any) => c.type === "text")?.text
              : msg.content;
            if (text && typeof text === "string" && !text.startsWith("/")) {
              messages.push({ role, text });
            }
          }
        }
      } catch {
        // Skip invalid JSON lines
      }
    }

    return messages.slice(-count);
  } catch {
    return [];
  }
}

/**
 * Convert a session key like "agent:main:main" to a filename-safe slug.
 */
function sessionKeyToSlug(sessionKey: string): string {
  return sessionKey.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * Truncate text to a max length, adding ellipsis if needed.
 */
function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return text.slice(0, maxChars - 3) + "...";
}

const saveSessionTurn: HookHandler = async (event) => {
  if (event.type !== "session" || event.action !== "turn-complete") {
    return;
  }

  try {
    const context = event.context || {};
    const cfg = context.cfg as OpenClawConfig | undefined;
    const sessionFile = context.sessionFile as string | undefined;
    const modelUsed = context.modelUsed as string | undefined;
    const providerUsed = context.providerUsed as string | undefined;
    const inputTokens = (context.inputTokens as number) ?? 0;
    const outputTokens = (context.outputTokens as number) ?? 0;
    const compacted = context.compacted === true;

    if (!sessionFile) {
      return;
    }

    const agentId = resolveAgentIdFromSessionKey(event.sessionKey);
    const workspaceDir = cfg
      ? resolveAgentWorkspaceDir(cfg, agentId)
      : path.join(os.homedir(), ".openclaw", "workspace");
    const sessionsDir = path.join(workspaceDir, "memory", "sessions");
    await fs.mkdir(sessionsDir, { recursive: true });

    // Read hook config for message count
    const hookConfig = resolveHookConfig(cfg, "session-autosave");
    const messageCount =
      typeof hookConfig?.messages === "number" && hookConfig.messages > 0 ? hookConfig.messages : 2;

    const messages = await getLastMessages(sessionFile, messageCount);
    if (messages.length === 0) {
      return;
    }

    // Build the log entry
    const now = event.timestamp;
    const dateStr = now.toISOString().split("T")[0];
    const timeStr = now.toISOString().split("T")[1].split(".")[0];
    const slug = sessionKeyToSlug(event.sessionKey);
    const filename = `${dateStr}-${slug}.md`;
    const logPath = path.join(sessionsDir, filename);

    const modelRef =
      providerUsed && modelUsed ? `${providerUsed}/${modelUsed}` : (modelUsed ?? "unknown");
    const tokenInfo =
      inputTokens + outputTokens > 0 ? ` | ${inputTokens}→${outputTokens} tokens` : "";
    const compactionNote = compacted ? " | compacted" : "";

    const parts: string[] = [];

    // Add header if this is a new file
    let isNewFile = true;
    try {
      await fs.access(logPath);
      isNewFile = false;
    } catch {
      // File doesn't exist yet
    }

    if (isNewFile) {
      parts.push(`# Session Log: ${event.sessionKey}`, "");
    }

    parts.push(`## Turn at ${timeStr} UTC (${modelRef}${tokenInfo}${compactionNote})`, "");

    for (const msg of messages) {
      const label = msg.role === "user" ? "User" : "Assistant";
      const trimmed = truncate(msg.text.trim(), 2000);
      parts.push(`**${label}:** ${trimmed}`, "");
    }

    parts.push("---", "");

    const entry = parts.join("\n");

    // Append to the log file
    await fs.appendFile(logPath, entry, "utf-8");
  } catch (err) {
    console.error(
      "[session-autosave] Failed to save session turn:",
      err instanceof Error ? err.message : String(err),
    );
  }
};

export default saveSessionTurn;
