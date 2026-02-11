import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { CONFIG_DIR } from "../utils.js";

export type RunHistoryEntry = {
  id: string;
  command: string;
  cwd?: string;
  status: "completed" | "failed" | "killed";
  exitCode: number | null;
  exitSignal: string | number | null;
  durationMs: number;
  outputTail: string;
  truncated: boolean;
  totalOutputChars: number;
  startedAt: number;
  endedAt: number;
  scopeKey?: string;
};

const MAX_LOG_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_ENTRIES_IN_MEMORY = 500;

let logFilePath: string | undefined;
let entriesCache: RunHistoryEntry[] | undefined;

function resolveLogPath(): string {
  if (logFilePath) return logFilePath;
  logFilePath = path.join(CONFIG_DIR, "run-history.jsonl");
  return logFilePath;
}

export function setRunHistoryPathForTest(p: string) {
  logFilePath = p;
  entriesCache = undefined;
}

export function resetRunHistoryForTest() {
  logFilePath = undefined;
  entriesCache = undefined;
}

export function appendRunEntry(entry: RunHistoryEntry): void {
  const filePath = resolveLogPath();
  try {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const line = JSON.stringify(entry) + "\n";
    fs.appendFileSync(filePath, line, "utf-8");

    // Update in-memory cache if loaded
    if (entriesCache) {
      entriesCache.push(entry);
      if (entriesCache.length > MAX_ENTRIES_IN_MEMORY) {
        entriesCache = entriesCache.slice(-MAX_ENTRIES_IN_MEMORY);
      }
    }

    // Rotate if too large
    try {
      const stat = fs.statSync(filePath);
      if (stat.size > MAX_LOG_SIZE_BYTES) {
        rotateLog(filePath);
      }
    } catch {
      // stat failure is non-fatal
    }
  } catch {
    // Logging failures are non-fatal; never crash the exec pipeline
  }
}

function rotateLog(filePath: string): void {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.trim().split("\n");
    // Keep the most recent half
    const keep = lines.slice(Math.floor(lines.length / 2));
    fs.writeFileSync(filePath, keep.join("\n") + "\n", "utf-8");
    entriesCache = undefined; // invalidate cache
  } catch {
    // rotation failure is non-fatal
  }
}

function loadEntries(): RunHistoryEntry[] {
  if (entriesCache) return entriesCache;
  const filePath = resolveLogPath();
  try {
    if (!fs.existsSync(filePath)) {
      entriesCache = [];
      return entriesCache;
    }
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);
    const entries: RunHistoryEntry[] = [];
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line) as RunHistoryEntry);
      } catch {
        // skip malformed lines
      }
    }
    // Keep only recent entries in memory
    entriesCache =
      entries.length > MAX_ENTRIES_IN_MEMORY ? entries.slice(-MAX_ENTRIES_IN_MEMORY) : entries;
    return entriesCache;
  } catch {
    entriesCache = [];
    return entriesCache;
  }
}

export function queryRunHistory(opts?: {
  limit?: number;
  status?: string;
  search?: string;
  since?: number;
  scope?: string;
}): RunHistoryEntry[] {
  let entries = loadEntries();
  const limit = opts?.limit ?? 20;

  if (opts?.status) {
    entries = entries.filter((e) => e.status === opts.status);
  }
  if (opts?.search) {
    const q = opts.search.toLowerCase();
    entries = entries.filter(
      (e) =>
        e.command.toLowerCase().includes(q) ||
        (e.cwd && e.cwd.toLowerCase().includes(q)) ||
        e.outputTail.toLowerCase().includes(q),
    );
  }
  if (opts?.since) {
    entries = entries.filter((e) => e.startedAt >= opts.since!);
  }
  if (opts?.scope) {
    entries = entries.filter((e) => e.scopeKey === opts.scope);
  }

  // Return most recent first, capped at limit
  return entries.slice(-limit).reverse();
}

export function getRunEntry(id: string): RunHistoryEntry | undefined {
  const entries = loadEntries();
  return entries.find((e) => e.id === id);
}

export async function clearRunHistory(): Promise<void> {
  const filePath = resolveLogPath();
  try {
    await fsp.rm(filePath, { force: true });
  } catch {
    // non-fatal
  }
  entriesCache = undefined;
}

export function runHistoryStats(): {
  totalRuns: number;
  completed: number;
  failed: number;
  killed: number;
} {
  const entries = loadEntries();
  return {
    totalRuns: entries.length,
    completed: entries.filter((e) => e.status === "completed").length,
    failed: entries.filter((e) => e.status === "failed").length,
    killed: entries.filter((e) => e.status === "killed").length,
  };
}
