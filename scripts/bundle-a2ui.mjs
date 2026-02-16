#!/usr/bin/env node
/**
 * Cross-platform A2UI bundler (replaces bundle-a2ui.sh for Windows compat).
 * Computes a content hash of the A2UI sources and only rebuilds when changed.
 */
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");

const HASH_FILE = path.join(ROOT_DIR, "src/canvas-host/a2ui/.bundle.hash");
const OUTPUT_FILE = path.join(ROOT_DIR, "src/canvas-host/a2ui/a2ui.bundle.js");
const A2UI_RENDERER_DIR = path.join(ROOT_DIR, "vendor/a2ui/renderers/lit");
const A2UI_APP_DIR = path.join(ROOT_DIR, "apps/shared/OpenClawKit/Tools/CanvasA2UI");

// Docker builds exclude vendor/apps via .dockerignore.
// In that environment we must keep the prebuilt bundle.
if (!fs.existsSync(A2UI_RENDERER_DIR) || !fs.existsSync(A2UI_APP_DIR)) {
  console.log("A2UI sources missing; keeping prebuilt bundle.");
  process.exit(0);
}

const INPUT_PATHS = [
  path.join(ROOT_DIR, "package.json"),
  path.join(ROOT_DIR, "pnpm-lock.yaml"),
  A2UI_RENDERER_DIR,
  A2UI_APP_DIR,
];

async function walk(entryPath) {
  const st = fs.statSync(entryPath);
  if (st.isDirectory()) {
    const entries = fs.readdirSync(entryPath);
    const results = [];
    for (const entry of entries) {
      results.push(...(await walk(path.join(entryPath, entry))));
    }
    return results;
  }
  return [entryPath];
}

function normalize(p) {
  return p.split(path.sep).join("/");
}

async function computeHash() {
  const files = [];
  for (const input of INPUT_PATHS) {
    files.push(...(await walk(input)));
  }
  files.sort((a, b) => normalize(a).localeCompare(normalize(b)));

  const hash = createHash("sha256");
  for (const filePath of files) {
    const rel = normalize(path.relative(ROOT_DIR, filePath));
    hash.update(rel);
    hash.update("\0");
    hash.update(fs.readFileSync(filePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

try {
  const currentHash = await computeHash();

  if (fs.existsSync(HASH_FILE) && fs.existsSync(OUTPUT_FILE)) {
    const previousHash = fs.readFileSync(HASH_FILE, "utf8").trim();
    if (previousHash === currentHash) {
      console.log("A2UI bundle up to date; skipping.");
      process.exit(0);
    }
  }

  execSync(`pnpm -s exec tsc -p "${A2UI_RENDERER_DIR}/tsconfig.json"`, {
    cwd: ROOT_DIR,
    stdio: "inherit",
  });
  execSync(`rolldown -c "${A2UI_APP_DIR}/rolldown.config.mjs"`, {
    cwd: ROOT_DIR,
    stdio: "inherit",
  });

  fs.writeFileSync(HASH_FILE, currentHash, "utf8");
} catch (err) {
  console.error("A2UI bundling failed. Re-run with: pnpm canvas:a2ui:bundle");
  console.error("If this persists, verify pnpm deps and try again.");
  process.exit(1);
}
