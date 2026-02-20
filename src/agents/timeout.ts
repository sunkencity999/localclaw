import type { OpenClawConfig } from "../config/config.js";

const DEFAULT_AGENT_TIMEOUT_SECONDS = 600;

/** Timeout for local models when an API orchestrator fallback is available. */
export const LOCAL_WITH_API_FALLBACK_TIMEOUT_SECONDS = 240;
/** Timeout for local-only setups (no API fallback). */
export const LOCAL_ONLY_TIMEOUT_SECONDS = 600;

const normalizeNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : undefined;

export function resolveAgentTimeoutSeconds(cfg?: OpenClawConfig): number {
  const raw = normalizeNumber(cfg?.agents?.defaults?.timeoutSeconds);
  const seconds = raw ?? DEFAULT_AGENT_TIMEOUT_SECONDS;
  return Math.max(seconds, 1);
}

export function resolveAgentTimeoutMs(opts: {
  cfg?: OpenClawConfig;
  overrideMs?: number | null;
  overrideSeconds?: number | null;
  minMs?: number;
}): number {
  const minMs = Math.max(normalizeNumber(opts.minMs) ?? 1, 1);
  const defaultMs = resolveAgentTimeoutSeconds(opts.cfg) * 1000;
  // Use a very large timeout value (30 days) to represent "no timeout"
  // when explicitly set to 0. This avoids setTimeout issues with Infinity.
  const NO_TIMEOUT_MS = 30 * 24 * 60 * 60 * 1000;
  const overrideMs = normalizeNumber(opts.overrideMs);
  if (overrideMs !== undefined) {
    if (overrideMs === 0) {
      return NO_TIMEOUT_MS;
    }
    if (overrideMs < 0) {
      return defaultMs;
    }
    return Math.max(overrideMs, minMs);
  }
  const overrideSeconds = normalizeNumber(opts.overrideSeconds);
  if (overrideSeconds !== undefined) {
    if (overrideSeconds === 0) {
      return NO_TIMEOUT_MS;
    }
    if (overrideSeconds < 0) {
      return defaultMs;
    }
    return Math.max(overrideSeconds * 1000, minMs);
  }
  return Math.max(defaultMs, minMs);
}

/**
 * Resolve a timeout for local model providers, taking API fallback
 * availability into account.  When an orchestrator API model is configured,
 * use a shorter timeout (4 min) so slow local runs escalate quickly.
 * Local-only setups get a generous 10 min timeout.
 */
export function resolveLocalModelTimeoutMs(opts: {
  cfg?: OpenClawConfig;
  hasApiFallback: boolean;
}): number {
  // Explicit user override always wins.
  const explicit = normalizeNumber(opts.cfg?.agents?.defaults?.timeoutSeconds);
  if (explicit !== undefined) {
    return Math.max(explicit * 1000, 1000);
  }
  const seconds = opts.hasApiFallback
    ? LOCAL_WITH_API_FALLBACK_TIMEOUT_SECONDS
    : LOCAL_ONLY_TIMEOUT_SECONDS;
  return seconds * 1000;
}
