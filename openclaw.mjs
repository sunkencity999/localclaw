#!/usr/bin/env node

// LocalClaw: fully isolated state directory so localclaw never shares
// sessions, locks, or agent data with a standard openclaw installation.
// State:  ~/.localclaw/          (vs ~/.openclaw/ for openclaw)
// Config: ~/.localclaw/openclaw.local.json
import { existsSync, copyFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

if (!process.env.OPENCLAW_STATE_DIR) {
  process.env.OPENCLAW_STATE_DIR = join(homedir(), ".localclaw");
}

if (!process.env.OPENCLAW_CONFIG_PATH) {
  process.env.OPENCLAW_CONFIG_PATH = join(
    process.env.OPENCLAW_STATE_DIR,
    "openclaw.local.json",
  );
}

// Migrate: if old config exists at ~/.openclaw/openclaw.local.json but
// the new location doesn't, copy it over so the user keeps their setup.
const newCfg = process.env.OPENCLAW_CONFIG_PATH;
const oldCfg = join(homedir(), ".openclaw", "openclaw.local.json");
if (!existsSync(newCfg) && existsSync(oldCfg)) {
  try {
    mkdirSync(dirname(newCfg), { recursive: true, mode: 0o700 });
    copyFileSync(oldCfg, newCfg);
  } catch {
    // best-effort migration
  }
}

if (!process.env.OPENCLAW_PROFILE) {
  process.env.OPENCLAW_PROFILE = "local";
}

import module from "node:module";

// https://nodejs.org/api/module.html#module-compile-cache
if (module.enableCompileCache && !process.env.NODE_DISABLE_COMPILE_CACHE) {
  try {
    module.enableCompileCache();
  } catch {
    // Ignore errors
  }
}

await import("./dist/entry.js");
