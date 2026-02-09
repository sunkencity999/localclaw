/**
 * Smart model routing — classify messages and route simple queries
 * to a fast/small model, preserving the primary model for complex tasks.
 *
 * Classification is heuristic-based (no LLM call) to avoid latency overhead.
 */

import type { OpenClawConfig } from "../../config/config.js";
import type { AgentRoutingConfig } from "../../config/types.agent-defaults.js";
import { parseModelRef } from "../../agents/model-selection.js";

export type RoutingDecision = {
  /** Whether the message was routed to the fast model. */
  routed: boolean;
  /** The provider to use. */
  provider: string;
  /** The model to use. */
  model: string;
  /** Classification result. */
  complexity: "simple" | "complex";
  /** Why this classification was chosen (for logging). */
  reason: string;
};

/** Keywords that strongly suggest a complex/agentic task. */
const COMPLEX_KEYWORDS = [
  "fix",
  "debug",
  "create",
  "build",
  "refactor",
  "edit",
  "write",
  "implement",
  "deploy",
  "install",
  "configure",
  "setup",
  "migrate",
  "update",
  "delete",
  "remove",
  "rename",
  "move",
  "copy",
  "commit",
  "push",
  "pull",
  "merge",
  "rebase",
  "compile",
  "test",
  "lint",
  "format",
  "analyze",
  "search",
  "find",
  "replace",
  "grep",
  "run",
  "execute",
  "script",
  "generate",
  "scaffold",
  "convert",
  "parse",
  "fetch",
  "download",
  "upload",
  "send",
  "schedule",
  "monitor",
  "restart",
];

/** Patterns that indicate complex content. */
const COMPLEX_PATTERNS = [
  /```/, // Code blocks
  /\/.+\.\w{1,5}/, // File paths (e.g., /src/foo.ts)
  /~\/.+/, // Home-relative paths
  /\b\d+\.\d+\.\d+\b/, // Version numbers (e.g., 1.2.3)
  /https?:\/\//, // URLs
  /\bfunction\b|\bclass\b|\bconst\b|\blet\b|\bvar\b/, // Code keywords
  /\bimport\b.*\bfrom\b/, // Import statements
  /\berror\b.*\b(at|in)\b/i, // Stack traces
  /\n.*\n.*\n/, // Multi-line (3+ lines)
];

const DEFAULT_MAX_SIMPLE_LENGTH = 150;

/**
 * Classify a user message as simple or complex using heuristics.
 */
export function classifyMessageComplexity(message: string): {
  complexity: "simple" | "complex";
  reason: string;
} {
  const trimmed = message.trim();

  // Empty or very short → simple
  if (trimmed.length === 0) {
    return { complexity: "simple", reason: "empty message" };
  }

  // Check for complex patterns first (these override length heuristics)
  for (const pattern of COMPLEX_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { complexity: "complex", reason: `matches pattern: ${pattern.source}` };
    }
  }

  // Check for complex keywords (word-boundary match)
  const lowerMessage = trimmed.toLowerCase();
  for (const keyword of COMPLEX_KEYWORDS) {
    const regex = new RegExp(`\\b${keyword}\\b`, "i");
    if (regex.test(lowerMessage)) {
      return { complexity: "complex", reason: `contains keyword: ${keyword}` };
    }
  }

  // Starts with a slash command → complex (it's a directive)
  if (trimmed.startsWith("/")) {
    return { complexity: "complex", reason: "slash command" };
  }

  // Multiple sentences (3+) → likely complex
  const sentenceCount = trimmed.split(/[.!?]+/).filter((s) => s.trim().length > 0).length;
  if (sentenceCount >= 3) {
    return { complexity: "complex", reason: `${sentenceCount} sentences` };
  }

  // If it's a short message, it's likely simple
  return { complexity: "simple", reason: "short conversational message" };
}

/**
 * Resolve the routing config from agent defaults.
 */
export function resolveRoutingConfig(cfg: OpenClawConfig): AgentRoutingConfig | null {
  const routing = cfg.agents?.defaults?.routing;
  if (!routing || routing.enabled !== true || !routing.fastModel) {
    return null;
  }
  return routing;
}

/**
 * Determine whether to route a message to the fast model.
 */
export function resolveSmartRoute(params: {
  message: string;
  cfg: OpenClawConfig;
  currentProvider: string;
  currentModel: string;
  defaultProvider: string;
}): RoutingDecision {
  const fallback: RoutingDecision = {
    routed: false,
    provider: params.currentProvider,
    model: params.currentModel,
    complexity: "complex",
    reason: "routing disabled or no fast model configured",
  };

  const routing = resolveRoutingConfig(params.cfg);
  if (!routing || !routing.fastModel) {
    return fallback;
  }

  const maxLen = routing.maxSimpleLength ?? DEFAULT_MAX_SIMPLE_LENGTH;
  const trimmed = params.message.trim();

  // If message is too long, don't even classify — it's complex
  if (trimmed.length > maxLen) {
    return {
      routed: false,
      provider: params.currentProvider,
      model: params.currentModel,
      complexity: "complex",
      reason: `message too long (${trimmed.length} > ${maxLen} chars)`,
    };
  }

  const { complexity, reason } = classifyMessageComplexity(trimmed);

  if (complexity === "complex") {
    return {
      routed: false,
      provider: params.currentProvider,
      model: params.currentModel,
      complexity,
      reason,
    };
  }

  // Parse the fast model ref
  const ref = parseModelRef(routing.fastModel, params.defaultProvider);
  if (!ref) {
    return {
      routed: false,
      provider: params.currentProvider,
      model: params.currentModel,
      complexity,
      reason: `invalid fast model ref: ${routing.fastModel}`,
    };
  }

  return {
    routed: true,
    provider: ref.provider,
    model: ref.model,
    complexity,
    reason,
  };
}
