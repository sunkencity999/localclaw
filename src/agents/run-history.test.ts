import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type RunHistoryEntry,
  appendRunEntry,
  clearRunHistory,
  getRunEntry,
  queryRunHistory,
  resetRunHistoryForTest,
  runHistoryStats,
  setRunHistoryPathForTest,
} from "./run-history.js";

function makeEntry(overrides: Partial<RunHistoryEntry> = {}): RunHistoryEntry {
  return {
    id: `test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    command: "echo hello",
    cwd: "/tmp",
    status: "completed",
    exitCode: 0,
    exitSignal: null,
    durationMs: 100,
    outputTail: "hello\n",
    truncated: false,
    totalOutputChars: 6,
    startedAt: Date.now() - 100,
    endedAt: Date.now(),
    ...overrides,
  };
}

describe("run-history", () => {
  let tmpDir: string;
  let logPath: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "run-hist-test-"));
    logPath = path.join(tmpDir, "run-history.jsonl");
    setRunHistoryPathForTest(logPath);
  });

  afterEach(async () => {
    resetRunHistoryForTest();
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it("appends entries and queries them", () => {
    const e1 = makeEntry({ id: "r1", command: "ls -la" });
    const e2 = makeEntry({ id: "r2", command: "cat file.txt", status: "failed", exitCode: 1 });
    appendRunEntry(e1);
    appendRunEntry(e2);

    const results = queryRunHistory();
    expect(results).toHaveLength(2);
    // Most recent first
    expect(results[0].id).toBe("r2");
    expect(results[1].id).toBe("r1");
  });

  it("filters by status", () => {
    appendRunEntry(makeEntry({ id: "ok", status: "completed" }));
    appendRunEntry(makeEntry({ id: "fail", status: "failed" }));

    const failed = queryRunHistory({ status: "failed" });
    expect(failed).toHaveLength(1);
    expect(failed[0].id).toBe("fail");
  });

  it("searches in command text", () => {
    appendRunEntry(makeEntry({ id: "a", command: "npm install" }));
    appendRunEntry(makeEntry({ id: "b", command: "pnpm test" }));

    const results = queryRunHistory({ search: "pnpm" });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("b");
  });

  it("respects limit", () => {
    for (let i = 0; i < 10; i++) {
      appendRunEntry(makeEntry({ id: `run-${i}` }));
    }
    const results = queryRunHistory({ limit: 3 });
    expect(results).toHaveLength(3);
  });

  it("gets entry by id", () => {
    appendRunEntry(makeEntry({ id: "target", command: "whoami" }));
    const entry = getRunEntry("target");
    expect(entry).toBeDefined();
    expect(entry!.command).toBe("whoami");
  });

  it("returns undefined for missing id", () => {
    expect(getRunEntry("nonexistent")).toBeUndefined();
  });

  it("computes stats", () => {
    appendRunEntry(makeEntry({ status: "completed" }));
    appendRunEntry(makeEntry({ status: "completed" }));
    appendRunEntry(makeEntry({ status: "failed" }));
    appendRunEntry(makeEntry({ status: "killed" }));

    const stats = runHistoryStats();
    expect(stats.totalRuns).toBe(4);
    expect(stats.completed).toBe(2);
    expect(stats.failed).toBe(1);
    expect(stats.killed).toBe(1);
  });

  it("clears history", async () => {
    appendRunEntry(makeEntry({ id: "doomed" }));
    expect(queryRunHistory()).toHaveLength(1);

    await clearRunHistory();
    expect(queryRunHistory()).toHaveLength(0);
  });

  it("persists to disk as JSONL", () => {
    appendRunEntry(makeEntry({ id: "persisted" }));
    expect(fs.existsSync(logPath)).toBe(true);

    const content = fs.readFileSync(logPath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]) as RunHistoryEntry;
    expect(parsed.id).toBe("persisted");
  });

  it("survives cache invalidation (reloads from disk)", () => {
    appendRunEntry(makeEntry({ id: "first" }));
    // Force cache invalidation
    resetRunHistoryForTest();
    setRunHistoryPathForTest(logPath);

    const results = queryRunHistory();
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("first");
  });

  it("filters by sinceMinutesAgo equivalent (since timestamp)", () => {
    const old = makeEntry({
      id: "old",
      startedAt: Date.now() - 2 * 60 * 60 * 1000, // 2 hours ago
    });
    const recent = makeEntry({
      id: "recent",
      startedAt: Date.now() - 5 * 60 * 1000, // 5 minutes ago
    });
    appendRunEntry(old);
    appendRunEntry(recent);

    const results = queryRunHistory({ since: Date.now() - 30 * 60 * 1000 });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("recent");
  });
});
