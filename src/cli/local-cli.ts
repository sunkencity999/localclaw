import type { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_AGENT_WORKSPACE_DIR } from "../agents/workspace.js";
import {
  applyPrimaryModel,
  LOCAL_MODEL_PROVIDERS,
  promptDefaultModel,
} from "../commands/model-picker.js";
import { ensureWorkspaceAndSessions } from "../commands/onboard-helpers.js";
import {
  createConfigIO,
  readConfigFileSnapshot,
  writeConfigFile,
  type OpenClawConfig,
} from "../config/config.js";
import { logConfigUpdated } from "../config/logging.js";
import { DEFAULT_GATEWAY_PORT, resolveStateDir } from "../config/paths.js";
import { defaultRuntime } from "../runtime.js";
import { runTui } from "../tui/tui.js";
import { createClackPrompter } from "../wizard/clack-prompter.js";
import { runCommandWithRuntime } from "./cli-utils.js";

async function loadMainConfigSnapshot(params: { sharedStateDir: string }) {
  const env = { ...process.env };
  delete env.OPENCLAW_CONFIG_PATH;
  env.OPENCLAW_STATE_DIR = params.sharedStateDir;
  return await createConfigIO({ env }).readConfigFileSnapshot();
}

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

async function ensureLocalConfigExists(params: {
  configPath: string;
}): Promise<{ created: boolean; config: OpenClawConfig }> {
  const snapshot = await readConfigFileSnapshot();
  if (snapshot.exists) {
    return { created: false, config: snapshot.config ?? {} };
  }

  const prompter = createClackPrompter();
  await prompter.intro("OpenClaw local");

  const sharedStateDir = resolveStateDir();
  const mainSnapshot = await loadMainConfigSnapshot({ sharedStateDir });
  const base = applyLocalDefaults(mainSnapshot.config ?? {});

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

  await prompter.outro("Local config ready.");

  return { created: true, config: next };
}

export function registerLocalCli(program: Command) {
  program
    .command("local")
    .description("Launch the terminal UI with a local-first configuration")
    .action(async () => {
      await runCommandWithRuntime(defaultRuntime, async () => {
        const sharedStateDir = resolveStateDir();
        process.env.OPENCLAW_PROFILE = "local";
        process.env.OPENCLAW_STATE_DIR = sharedStateDir;
        const configPath = path.join(sharedStateDir, "openclaw.local.json");
        process.env.OPENCLAW_CONFIG_PATH = configPath;

        await ensureLocalConfigExists({ configPath });

        await runTui({});
      });
    });
}
