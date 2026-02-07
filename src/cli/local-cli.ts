import fs from "node:fs";
import path from "node:path";
import {
  applyPrimaryModel,
  LOCAL_MODEL_PROVIDERS,
  promptDefaultModel,
} from "../commands/model-picker.js";
import { ensureWorkspaceAndSessions } from "../commands/onboard-helpers.js";
import { writeConfigFile, type OpenClawConfig } from "../config/config.js";
import { logConfigUpdated } from "../config/logging.js";
import { resolveStateDir } from "../config/paths.js";
import { DEFAULT_GATEWAY_PORT } from "../config/paths.js";
import { defaultRuntime } from "../runtime.js";
import { createClackPrompter } from "../wizard/clack-prompter.js";

function applyLocalDefaults(cfg: OpenClawConfig): OpenClawConfig {
  const defaults = cfg.agents?.defaults ?? {};

  // Workspace must live under the localclaw state dir, not ~/.openclaw/.
  // Override any migrated workspace that still points into .openclaw.
  const stateDir = resolveStateDir();
  const defaultLocalWorkspace = path.join(stateDir, "workspace");
  const workspace =
    defaults.workspace && !defaults.workspace.includes("/.openclaw/")
      ? defaults.workspace
      : defaultLocalWorkspace;
  const basePort =
    typeof cfg.gateway?.port === "number" &&
    Number.isFinite(cfg.gateway.port) &&
    cfg.gateway.port > 0
      ? cfg.gateway.port
      : DEFAULT_GATEWAY_PORT;
  const port = basePort === DEFAULT_GATEWAY_PORT ? DEFAULT_GATEWAY_PORT + 1 : basePort;

  // --- Aggressive context management for small local models ---

  // Context pruning: "always" mode prunes every turn (no cache-ttl gating).
  // Lower thresholds so pruning kicks in early and tool results are trimmed aggressively.
  const contextPruning = {
    mode: "always" as const,
    keepLastAssistants: 2,
    softTrimRatio: 0.2,
    hardClearRatio: 0.4,
    minPrunableToolChars: 10_000,
    softTrim: {
      maxChars: 2_000,
      headChars: 800,
      tailChars: 800,
    },
    hardClear: {
      enabled: true,
      placeholder: "[Tool result cleared to save context]",
    },
    ...defaults.contextPruning,
  };

  // Compaction: safeguard mode with a smaller history share so more room is
  // left for the current task. Lower reserve tokens floor for small windows.
  const compaction = {
    mode: "safeguard" as const,
    reserveTokensFloor: 2_000,
    maxHistoryShare: 0.3,
    memoryFlush: {
      enabled: true,
      softThresholdTokens: 2_000,
      compactionInterval: 1,
      ...defaults.compaction?.memoryFlush,
    },
    ...defaults.compaction,
  };
  // Ensure nested memoryFlush isn't overwritten by the spread above
  compaction.memoryFlush = {
    enabled: true,
    softThresholdTokens: 2_000,
    compactionInterval: 1,
    ...defaults.compaction?.memoryFlush,
  };

  // Lower bootstrap max chars to reduce system prompt size for small context windows.
  const bootstrapMaxChars = defaults.bootstrapMaxChars ?? 8_000;

  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...defaults,
        workspace,
        contextPruning,
        compaction,
        bootstrapMaxChars,
        // Local models are slower; give them more time per turn.
        timeoutSeconds: defaults.timeoutSeconds ?? 180,
      },
    },
    gateway: {
      ...cfg.gateway,
      mode: "local",
      port,
    },
    session: {
      ...cfg.session,
    },
  };
}

/**
 * Run the local-model onboarding flow when the localclaw config file
 * does not yet exist. Called from the config-guard on first run.
 */
export async function runLocalOnboarding(params: { configPath: string }): Promise<void> {
  const prompter = createClackPrompter();
  await prompter.intro("LocalClaw — first-run setup");

  const base = applyLocalDefaults({});

  const selection = await promptDefaultModel({
    config: base,
    prompter,
    allowKeep: false,
    includeManual: true,
    ignoreAllowlist: true,
    filterProviders: [...LOCAL_MODEL_PROVIDERS],
    message: "Default local model",
  });

  let next = base;
  if (selection.model) {
    next = applyPrimaryModel(next, selection.model);
  }

  await writeConfigFile(next);
  logConfigUpdated(defaultRuntime, { path: params.configPath });

  const workspaceDir =
    next.agents?.defaults?.workspace ?? path.join(resolveStateDir(), "workspace");
  await fs.promises
    .mkdir(path.dirname(params.configPath), { recursive: true, mode: 0o700 })
    .catch(() => {
      // best-effort
    });
  await ensureWorkspaceAndSessions(workspaceDir, defaultRuntime, {
    skipBootstrap: Boolean(next.agents?.defaults?.skipBootstrap),
  });

  await prompter.outro("Local config ready. Run any localclaw command to get started.");
}
