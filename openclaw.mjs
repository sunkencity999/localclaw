#!/usr/bin/env node

// LocalClaw: override config to use the local-specific config file.
// This ensures every command (config, status, onboard, tui, etc.) uses
// ~/.openclaw/openclaw.local.json instead of the main openclaw.json.
import { homedir } from "node:os";
import { join } from "node:path";

if (!process.env.OPENCLAW_CONFIG_PATH) {
  const stateDir = process.env.OPENCLAW_STATE_DIR || join(homedir(), ".openclaw");
  process.env.OPENCLAW_CONFIG_PATH = join(stateDir, "openclaw.local.json");
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
