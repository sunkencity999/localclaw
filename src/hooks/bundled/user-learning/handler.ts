/**
 * User learning hook handler
 *
 * Observes session:turn-complete events and updates the user
 * preferences profile based on the user's message patterns.
 */

import type { OpenClawConfig } from "../../../config/config.js";
import type { HookHandler } from "../../hooks.js";
import { resolveAgentWorkspaceDir } from "../../../agents/agent-scope.js";
import {
  loadPreferences,
  savePreferences,
  updatePreferencesFromMessage,
} from "../../../infra/user-preferences.js";
import { resolveAgentIdFromSessionKey } from "../../../routing/session-key.js";

const learnFromTurn: HookHandler = async (event) => {
  if (event.type !== "session" || event.action !== "turn-complete") {
    return;
  }

  try {
    const context = event.context || {};
    const cfg = context.cfg as OpenClawConfig | undefined;
    const userMessage = context.userMessage as string | undefined;

    if (!userMessage || typeof userMessage !== "string" || userMessage.trim().length === 0) {
      return;
    }

    const agentId = resolveAgentIdFromSessionKey(event.sessionKey || "agent:main:main");
    const workspaceDir = cfg ? resolveAgentWorkspaceDir(cfg, agentId) : undefined;

    if (!workspaceDir) {
      return;
    }

    const prefs = await loadPreferences(workspaceDir);
    updatePreferencesFromMessage(prefs, userMessage);
    await savePreferences(workspaceDir, prefs);
  } catch (err) {
    console.error(
      "[user-learning] Failed to update preferences:",
      err instanceof Error ? err.message : String(err),
    );
  }
};

export default learnFromTurn;
