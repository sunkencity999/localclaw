/**
 * Smart model routing — classify messages and route simple queries
 * to a fast/small model, preserving the primary model for complex tasks.
 *
 * Classification is heuristic-based (no LLM call) to avoid latency overhead.
 */

import type { OpenClawConfig } from "../../config/config.js";
import type {
  AgentOrchestratorConfig,
  AgentRoutingConfig,
} from "../../config/types.agent-defaults.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../agents/defaults.js";
import {
  modelKey,
  parseModelRef,
  resolveConfiguredModelRef,
} from "../../agents/model-selection.js";

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
  "check",
  "read",
  "review",
  "summarize",
  "show",
  "list",
  "look",
  "inspect",
  "verify",
  "scan",
  "open",
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

// ---------------------------------------------------------------------------
// Orchestrator routing — route complex tasks UP to a powerful API model,
// keep simple/routine work on the local model.
// ---------------------------------------------------------------------------

/**
 * Resolve the orchestrator config from agent defaults.
 */
export function resolveOrchestratorConfig(cfg: OpenClawConfig): AgentOrchestratorConfig | null {
  const orchestrator = cfg.agents?.defaults?.orchestrator;
  if (!orchestrator || orchestrator.enabled !== true || !orchestrator.model) {
    return null;
  }
  return orchestrator;
}

export type OrchestratorRoutingDecision = RoutingDecision & {
  /** When true, the local model should be added as a fallback for this run. */
  localFallback?: { provider: string; model: string };
  /** When "fallback-only", the orchestrator model should be a fallback for the local run. */
  orchestratorFallback?: { provider: string; model: string };
};

/**
 * Determine whether to route a message to the orchestrator (powerful API) model.
 *
 * - "auto": complex messages → orchestrator, simple → local (default)
 * - "always": always use orchestrator, local is fallback
 * - "fallback-only": use local, orchestrator is fallback when local fails
 */
export function resolveOrchestratorRoute(params: {
  message: string;
  cfg: OpenClawConfig;
  currentProvider: string;
  currentModel: string;
  defaultProvider: string;
}): OrchestratorRoutingDecision {
  const noRoute: OrchestratorRoutingDecision = {
    routed: false,
    provider: params.currentProvider,
    model: params.currentModel,
    complexity: "complex",
    reason: "orchestrator disabled or no model configured",
  };

  const orchestrator = resolveOrchestratorConfig(params.cfg);
  if (!orchestrator?.model) {
    return noRoute;
  }

  const ref = parseModelRef(orchestrator.model, params.defaultProvider);
  if (!ref) {
    return { ...noRoute, reason: `invalid orchestrator model ref: ${orchestrator.model}` };
  }

  const strategy = orchestrator.strategy ?? "auto";
  const localModel = { provider: params.currentProvider, model: params.currentModel };

  // "always" — always use orchestrator, local is fallback
  if (strategy === "always") {
    return {
      routed: true,
      provider: ref.provider,
      model: ref.model,
      complexity: "complex",
      reason: "orchestrator strategy: always",
      localFallback: localModel,
    };
  }

  // "fallback-only" — use local by default, orchestrator is fallback when local fails
  if (strategy === "fallback-only") {
    return {
      routed: false,
      provider: params.currentProvider,
      model: params.currentModel,
      complexity: "complex",
      reason: "orchestrator strategy: fallback-only (orchestrator available as fallback)",
      orchestratorFallback: { provider: ref.provider, model: ref.model },
    };
  }

  // "auto" — classify and route complex tasks to orchestrator
  const maxLen = orchestrator.maxSimpleLength ?? DEFAULT_MAX_SIMPLE_LENGTH;
  const trimmed = params.message.trim();

  // Long messages are complex
  if (trimmed.length > maxLen) {
    return {
      routed: true,
      provider: ref.provider,
      model: ref.model,
      complexity: "complex",
      reason: `message too long for local (${trimmed.length} > ${maxLen} chars)`,
      localFallback: localModel,
    };
  }

  const { complexity, reason } = classifyMessageComplexity(trimmed);

  if (complexity === "complex") {
    return {
      routed: true,
      provider: ref.provider,
      model: ref.model,
      complexity,
      reason: `orchestrator: ${reason}`,
      localFallback: localModel,
    };
  }

  // Simple message → stay on local
  return {
    routed: false,
    provider: params.currentProvider,
    model: params.currentModel,
    complexity,
    reason,
  };
}

/**
 * Resolve fallback overrides for a run, injecting orchestrator ↔ local fallbacks.
 *
 * - If the run is using the orchestrator API model → inject the local primary as fallback.
 * - If strategy is "fallback-only" and using local → inject orchestrator as fallback.
 * - Otherwise, return the existing per-agent fallbacks unchanged.
 */
export function resolveOrchestratorFallbacksForRun(params: {
  cfg: OpenClawConfig;
  runProvider: string;
  runModel: string;
  agentFallbacks?: string[];
}): string[] | undefined {
  const orchestrator = resolveOrchestratorConfig(params.cfg);
  if (!orchestrator?.model) {
    return params.agentFallbacks;
  }

  const orchRef = parseModelRef(orchestrator.model, DEFAULT_PROVIDER);
  if (!orchRef) {
    return params.agentFallbacks;
  }

  const orchKey = modelKey(orchRef.provider, orchRef.model);
  const runKey = modelKey(params.runProvider, params.runModel);
  const primary = resolveConfiguredModelRef({
    cfg: params.cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const primaryKey = modelKey(primary.provider, primary.model);

  const strategy = orchestrator.strategy ?? "auto";

  // Running on orchestrator model → add local primary as fallback
  if (runKey === orchKey) {
    const existing = params.agentFallbacks ?? [];
    if (existing.includes(primaryKey)) {
      return existing;
    }
    return [primaryKey, ...existing];
  }

  // "fallback-only" and running on local → add orchestrator as fallback
  if (strategy === "fallback-only" && runKey === primaryKey) {
    const existing = params.agentFallbacks ?? [];
    if (existing.includes(orchKey)) {
      return existing;
    }
    return [...existing, orchKey];
  }

  return params.agentFallbacks;
}
