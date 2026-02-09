/**
 * Workspace file watcher — monitors workspace files for changes and
 * fires internal hook events when significant files are modified.
 *
 * Uses Node.js fs.watch (recursive) for low-overhead watching.
 */

import fs from "node:fs";
import path from "node:path";
import { createInternalHookEvent, triggerInternalHook } from "../hooks/internal-hooks.js";

export type WatcherOptions = {
  workspaceDir: string;
  /** Files/patterns to watch (relative to workspace). Default: all .md files. */
  patterns?: string[];
  /** Debounce interval in ms (default: 2000). */
  debounceMs?: number;
};

type PendingChange = {
  filename: string;
  eventType: string;
  timestamp: number;
};

export type WorkspaceWatcher = {
  stop: () => void;
};

const DEFAULT_DEBOUNCE_MS = 2000;
const DEFAULT_PATTERNS = [".md", ".yaml", ".yml", ".json"];

function matchesPatterns(filename: string, patterns: string[]): boolean {
  const ext = path.extname(filename).toLowerCase();
  return patterns.some((p) => {
    if (p.startsWith(".")) {
      return ext === p.toLowerCase();
    }
    return filename.toLowerCase().includes(p.toLowerCase());
  });
}

export function startWorkspaceWatcher(opts: WatcherOptions): WorkspaceWatcher {
  const { workspaceDir } = opts;
  const patterns = opts.patterns ?? DEFAULT_PATTERNS;
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  let watcher: fs.FSWatcher | null = null;
  let debounceTimer: NodeJS.Timeout | null = null;
  const pending = new Map<string, PendingChange>();

  const flush = () => {
    if (pending.size === 0) {
      return;
    }

    const changes = [...pending.values()];
    pending.clear();

    for (const change of changes) {
      const hookEvent = createInternalHookEvent(
        "workspace",
        "file-changed",
        "workspace:file-changed",
        {
          workspaceDir,
          filename: change.filename,
          eventType: change.eventType,
          timestamp: change.timestamp,
        },
      );
      void triggerInternalHook(hookEvent);
    }
  };

  const handleChange = (eventType: string, filename: string | null) => {
    if (!filename) {
      return;
    }

    // Skip hidden files, node_modules, etc.
    if (filename.startsWith(".") || filename.includes("node_modules")) {
      return;
    }

    if (!matchesPatterns(filename, patterns)) {
      return;
    }

    pending.set(filename, {
      filename,
      eventType,
      timestamp: Date.now(),
    });

    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(flush, debounceMs);
    debounceTimer.unref?.();
  };

  try {
    watcher = fs.watch(workspaceDir, { recursive: true }, handleChange);
    watcher.on("error", () => {
      // Silently handle errors (directory deleted, etc.)
    });
  } catch {
    // fs.watch not supported or directory doesn't exist
  }

  return {
    stop: () => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (watcher) {
        watcher.close();
        watcher = null;
      }
      pending.clear();
    },
  };
}
