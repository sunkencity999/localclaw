import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  applyPrimaryModel,
  LOCAL_MODEL_PROVIDERS,
  promptDefaultModel,
} from "../commands/model-picker.js";
import {
  detectBrowserOpenSupport,
  ensureWorkspaceAndSessions,
  openUrl,
  probeGatewayReachable,
  resolveControlUiLinks,
  waitForGatewayReachable,
} from "../commands/onboard-helpers.js";
import { writeConfigFile, type OpenClawConfig } from "../config/config.js";
import { logConfigUpdated } from "../config/logging.js";
import { resolveStateDir } from "../config/paths.js";
import { DEFAULT_GATEWAY_PORT } from "../config/paths.js";
import { defaultRuntime } from "../runtime.js";
import { runTui } from "../tui/tui.js";
import { createClackPrompter } from "../wizard/clack-prompter.js";
import { formatCliCommand } from "./command-format.js";

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

async function startGatewayInBackground(port: number): Promise<{
  ok: boolean;
  logPath: string;
  detail?: string;
}> {
  const stateDir = resolveStateDir();
  const logPath = path.join(stateDir, "logs", "gateway-first-run.log");
  const entryArg = process.argv[1];
  if (!entryArg) {
    return { ok: false, logPath, detail: "Unable to resolve LocalClaw CLI entrypoint." };
  }

  await fs.promises.mkdir(path.dirname(logPath), { recursive: true, mode: 0o700 }).catch(() => {
    // best-effort
  });

  let logFd: number | undefined;
  try {
    logFd = fs.openSync(logPath, "a", 0o600);
    const child = spawn(
      process.execPath,
      [entryArg, "gateway", "run", "--bind", "loopback", "--port", String(port), "--force"],
      {
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env: process.env,
      },
    );
    child.unref();
    return { ok: true, logPath };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, logPath, detail };
  } finally {
    if (logFd !== undefined) {
      try {
        fs.closeSync(logFd);
      } catch {
        // best-effort
      }
    }
  }
}

async function runFirstRunLaunchpad(params: {
  cfg: OpenClawConfig;
  prompter: ReturnType<typeof createClackPrompter>;
}) {
  const { cfg, prompter } = params;
  const port =
    typeof cfg.gateway?.port === "number" &&
    Number.isFinite(cfg.gateway.port) &&
    cfg.gateway.port > 0
      ? cfg.gateway.port
      : DEFAULT_GATEWAY_PORT + 1;
  const bind = cfg.gateway?.bind ?? "loopback";
  const customBindHost = cfg.gateway?.customBindHost;
  const links = resolveControlUiLinks({
    port,
    bind,
    customBindHost,
    basePath: cfg.gateway?.controlUi?.basePath,
  });

  const token = cfg.gateway?.auth?.token ?? process.env.OPENCLAW_GATEWAY_TOKEN;
  const password = cfg.gateway?.auth?.password ?? process.env.OPENCLAW_GATEWAY_PASSWORD;

  let gatewayProbe = await probeGatewayReachable({
    url: links.wsUrl,
    token,
    password,
  });

  if (!gatewayProbe.ok) {
    const startNow = await prompter.confirm({
      message: "Start the local Gateway now?",
      initialValue: true,
    });
    if (startNow) {
      const started = await startGatewayInBackground(port);
      if (!started.ok) {
        await prompter.note(
          [
            `Failed to start Gateway automatically: ${started.detail ?? "unknown error"}`,
            `Start it manually: ${formatCliCommand(`localclaw gateway run --bind loopback --port ${port} --force`)}`,
          ].join("\n"),
          "Gateway",
        );
      } else {
        await prompter.note(
          [`Starting Gateway in the background…`, `Log: ${started.logPath}`].join("\n"),
          "Gateway",
        );
        gatewayProbe = await waitForGatewayReachable({
          url: links.wsUrl,
          token,
          password,
          deadlineMs: 12_000,
        });
      }
    }
  }

  if (!gatewayProbe.ok) {
    await prompter.note(
      [
        `Gateway is not reachable yet (${links.wsUrl}).`,
        `Start later: ${formatCliCommand(`localclaw gateway run --bind loopback --port ${port} --force`)}`,
        `Then chat: ${formatCliCommand("localclaw tui")}`,
        `Dashboard: ${formatCliCommand("localclaw dashboard --no-open")}`,
      ].join("\n"),
      "Next steps",
    );
    return;
  }

  const openTuiNow = await prompter.confirm({
    message: "Open chat in TUI now?",
    initialValue: true,
  });
  if (openTuiNow) {
    try {
      await runTui({
        url: links.wsUrl,
        token,
        password: password ?? "",
        deliver: false,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      await prompter.note(`TUI failed to open: ${detail}`, "TUI");
    }
  }

  const openWebNow = await prompter.confirm({
    message: "Open the Web UI now?",
    initialValue: !openTuiNow,
  });
  if (openWebNow) {
    const authedUrl = token ? `${links.httpUrl}?token=${encodeURIComponent(token)}` : links.httpUrl;
    const browserSupport = await detectBrowserOpenSupport();
    if (browserSupport.ok) {
      const opened = await openUrl(authedUrl);
      if (!opened) {
        await prompter.note(`Dashboard URL: ${authedUrl}`, "Web UI");
      }
    } else {
      await prompter.note(`Dashboard URL: ${authedUrl}`, "Web UI");
    }
  }

  if (!openTuiNow && !openWebNow) {
    await prompter.note(
      [
        `Chat: ${formatCliCommand("localclaw tui")}`,
        `Dashboard: ${formatCliCommand("localclaw dashboard --no-open")}`,
      ].join("\n"),
      "Next steps",
    );
  }
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

  if (process.stdout.isTTY && process.stdin.isTTY) {
    await runFirstRunLaunchpad({ cfg: next, prompter });
  }

  await prompter.outro("Local config ready. Run any localclaw command to get started.");
}
