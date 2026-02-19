/**
 * Gmail Watcher Service
 *
 * Automatically starts `gog gmail watch serve` when the gateway starts,
 * if hooks.gmail is configured with an account (or multiple accounts).
 *
 * Multi-account: when `hooks.gmail.accounts[]` is configured, one watcher
 * process is spawned per account, each on its own port.
 */

import { type ChildProcess, spawn } from "node:child_process";
import type { OpenClawConfig } from "../config/config.js";
import { hasBinary } from "../agents/skills.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { ensureTailscaleEndpoint } from "./gmail-setup-utils.js";
import {
  buildGogWatchServeArgs,
  buildGogWatchStartArgs,
  type GmailHookRuntimeConfig,
  resolveGmailMultiAccountConfigs,
} from "./gmail.js";

const log = createSubsystemLogger("gmail-watcher");

const ADDRESS_IN_USE_RE = /address already in use|EADDRINUSE/i;

export function isAddressInUseError(line: string): boolean {
  return ADDRESS_IN_USE_RE.test(line);
}

// ── Per-account watcher state ────────────────────────────────────────────────

type WatcherEntry = {
  config: GmailHookRuntimeConfig;
  process: ChildProcess | null;
  renewInterval: ReturnType<typeof setInterval> | null;
};

const watchers = new Map<string, WatcherEntry>();
let shuttingDown = false;

/**
 * Check if gog binary is available
 */
function isGogAvailable(): boolean {
  return hasBinary("gog");
}

/**
 * Start the Gmail watch (registers with Gmail API)
 */
async function startGmailWatch(
  cfg: Pick<GmailHookRuntimeConfig, "account" | "label" | "topic">,
): Promise<boolean> {
  const args = ["gog", ...buildGogWatchStartArgs(cfg)];
  try {
    const result = await runCommandWithTimeout(args, { timeoutMs: 120_000 });
    if (result.code !== 0) {
      const message = result.stderr || result.stdout || "gog watch start failed";
      log.error(`[${cfg.account}] watch start failed: ${message}`);
      return false;
    }
    log.info(`[${cfg.account}] watch started`);
    return true;
  } catch (err) {
    log.error(`[${cfg.account}] watch start error: ${String(err)}`);
    return false;
  }
}

/**
 * Spawn the gog gmail watch serve process for one account.
 */
function spawnGogServe(entry: WatcherEntry): ChildProcess {
  const cfg = entry.config;
  const args = buildGogWatchServeArgs(cfg);
  log.info(`[${cfg.account}] starting gog ${args.join(" ")}`);
  let addressInUse = false;

  const child = spawn("gog", args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  child.stdout?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (line) {
      log.info(`[${cfg.account}] ${line}`);
    }
  });

  child.stderr?.on("data", (data: Buffer) => {
    const line = data.toString().trim();
    if (!line) {
      return;
    }
    if (isAddressInUseError(line)) {
      addressInUse = true;
    }
    log.warn(`[${cfg.account}] ${line}`);
  });

  child.on("error", (err) => {
    log.error(`[${cfg.account}] gog process error: ${String(err)}`);
  });

  child.on("exit", (code, signal) => {
    if (shuttingDown) {
      return;
    }
    if (addressInUse) {
      log.warn(
        `[${cfg.account}] gog serve failed to bind (address already in use); stopping restarts. ` +
          "Another watcher is likely running. Set OPENCLAW_SKIP_GMAIL_WATCHER=1 or stop the other process.",
      );
      entry.process = null;
      return;
    }
    log.warn(`[${cfg.account}] gog exited (code=${code}, signal=${signal}); restarting in 5s`);
    entry.process = null;
    setTimeout(() => {
      if (shuttingDown) {
        return;
      }
      entry.process = spawnGogServe(entry);
    }, 5000);
  });

  return child;
}

export type GmailWatcherStartResult = {
  started: boolean;
  reason?: string;
  /** Number of accounts started (multi-account). */
  accountCount?: number;
};

/**
 * Start the Gmail watcher service.
 * Called automatically by the gateway if hooks.gmail is configured.
 * Supports multi-account via `hooks.gmail.accounts[]`.
 */
export async function startGmailWatcher(cfg: OpenClawConfig): Promise<GmailWatcherStartResult> {
  if (!cfg.hooks?.enabled) {
    return { started: false, reason: "hooks not enabled" };
  }

  const hasLegacy = Boolean(cfg.hooks?.gmail?.account);
  const hasMulti = (cfg.hooks?.gmail?.accounts?.length ?? 0) > 0;
  if (!hasLegacy && !hasMulti) {
    return { started: false, reason: "no gmail account configured" };
  }

  if (!isGogAvailable()) {
    return { started: false, reason: "gog binary not found" };
  }

  const resolved = resolveGmailMultiAccountConfigs(cfg, {});
  if (!resolved.ok) {
    return { started: false, reason: resolved.error };
  }

  shuttingDown = false;
  let startedCount = 0;

  for (const runtimeConfig of resolved.value) {
    const acct = runtimeConfig.account;

    // Set up Tailscale endpoint if needed
    if (runtimeConfig.tailscale.mode !== "off") {
      try {
        await ensureTailscaleEndpoint({
          mode: runtimeConfig.tailscale.mode,
          path: runtimeConfig.tailscale.path,
          port: runtimeConfig.serve.port,
          target: runtimeConfig.tailscale.target,
        });
        log.info(
          `[${acct}] tailscale ${runtimeConfig.tailscale.mode} configured for port ${runtimeConfig.serve.port}`,
        );
      } catch (err) {
        log.error(`[${acct}] tailscale setup failed: ${String(err)}`);
        continue;
      }
    }

    // Register with Gmail API
    const watchStarted = await startGmailWatch(runtimeConfig);
    if (!watchStarted) {
      log.warn(`[${acct}] gmail watch start failed, but continuing with serve`);
    }

    // Create watcher entry and spawn serve process
    const entry: WatcherEntry = {
      config: runtimeConfig,
      process: null,
      renewInterval: null,
    };
    entry.process = spawnGogServe(entry);

    // Set up renewal interval for this account
    const renewMs = runtimeConfig.renewEveryMinutes * 60_000;
    entry.renewInterval = setInterval(() => {
      if (shuttingDown) {
        return;
      }
      void startGmailWatch(runtimeConfig);
    }, renewMs);

    watchers.set(acct, entry);
    startedCount++;

    log.info(
      `[${acct}] gmail watcher started on port ${runtimeConfig.serve.port} (renew every ${runtimeConfig.renewEveryMinutes}m)`,
    );
  }

  if (startedCount === 0) {
    return { started: false, reason: "no accounts could be started" };
  }

  return { started: true, accountCount: startedCount };
}

/**
 * Stop all Gmail watcher processes.
 */
export async function stopGmailWatcher(): Promise<void> {
  shuttingDown = true;

  const stopPromises: Promise<void>[] = [];

  for (const [acct, entry] of watchers) {
    if (entry.renewInterval) {
      clearInterval(entry.renewInterval);
      entry.renewInterval = null;
    }

    if (entry.process) {
      log.info(`[${acct}] stopping gmail watcher`);
      entry.process.kill("SIGTERM");

      stopPromises.push(
        new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            if (entry.process) {
              entry.process.kill("SIGKILL");
            }
            resolve();
          }, 3000);

          entry.process?.on("exit", () => {
            clearTimeout(timeout);
            resolve();
          });
        }),
      );
    }
  }

  await Promise.all(stopPromises);
  watchers.clear();
  log.info("all gmail watchers stopped");
}

/**
 * Check if at least one Gmail watcher is running.
 */
export function isGmailWatcherRunning(): boolean {
  if (shuttingDown) return false;
  for (const entry of watchers.values()) {
    if (entry.process !== null) return true;
  }
  return false;
}
