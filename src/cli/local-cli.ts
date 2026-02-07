import fs from "node:fs";
import path from "node:path";
import { DEFAULT_AGENT_WORKSPACE_DIR } from "../agents/workspace.js";
import {
  applyPrimaryModel,
  LOCAL_MODEL_PROVIDERS,
  promptDefaultModel,
} from "../commands/model-picker.js";
import { ensureWorkspaceAndSessions } from "../commands/onboard-helpers.js";
import { writeConfigFile, type OpenClawConfig } from "../config/config.js";
import { logConfigUpdated } from "../config/logging.js";
import { DEFAULT_GATEWAY_PORT } from "../config/paths.js";
import { defaultRuntime } from "../runtime.js";
import { createClackPrompter } from "../wizard/clack-prompter.js";

function applyLocalDefaults(cfg: OpenClawConfig): OpenClawConfig {
  const defaults = cfg.agents?.defaults ?? {};
  const workspace = defaults.workspace ?? DEFAULT_AGENT_WORKSPACE_DIR;
  const basePort =
    typeof cfg.gateway?.port === "number" &&
    Number.isFinite(cfg.gateway.port) &&
    cfg.gateway.port > 0
      ? cfg.gateway.port
      : DEFAULT_GATEWAY_PORT;
  const port = basePort === DEFAULT_GATEWAY_PORT ? DEFAULT_GATEWAY_PORT + 1 : basePort;
  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      defaults: {
        ...defaults,
        workspace,
      },
    },
    gateway: {
      ...cfg.gateway,
      mode: "local",
      port,
    },
    session: {
      ...cfg.session,
      mainKey: cfg.session?.mainKey ?? "local",
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

  const workspaceDir = next.agents?.defaults?.workspace ?? DEFAULT_AGENT_WORKSPACE_DIR;
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
