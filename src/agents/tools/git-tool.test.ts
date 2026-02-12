import { describe, expect, it } from "vitest";
import { createGitTool } from "./git-tool.js";

describe("git tool", () => {
  const tool = createGitTool();
  // Use the localclaw repo itself as the test subject
  const cwd = process.cwd();

  it("has correct name and schema", () => {
    expect(tool.name).toBe("git");
    expect(tool.parameters).toBeDefined();
  });

  it("gets status", async () => {
    const result = await tool.execute("call-1", { action: "status", cwd });
    const details = result.details as Record<string, unknown>;
    expect(details.branch).toBeDefined();
    expect(typeof details.changedFiles).toBe("number");
    expect(typeof details.stashCount).toBe("number");
  });

  it("gets log", async () => {
    const result = await tool.execute("call-2", {
      action: "log",
      cwd,
      maxCount: 5,
    });
    const details = result.details as Record<string, unknown>;
    expect(details.entries).toBeGreaterThan(0);
    const text = result.content?.[0];
    expect(text).toBeDefined();
  });

  it("gets diff", async () => {
    const result = await tool.execute("call-3", {
      action: "diff",
      cwd,
      ref: "HEAD~1",
    });
    const details = result.details as Record<string, unknown>;
    expect(typeof details.statsLines).toBe("number");
  });

  it("lists branches", async () => {
    const result = await tool.execute("call-4", { action: "branch", cwd });
    const details = result.details as Record<string, unknown>;
    expect(details.current).toBeDefined();
    expect(details.localCount).toBeGreaterThan(0);
  });

  it("shows a commit", async () => {
    const result = await tool.execute("call-5", {
      action: "show",
      cwd,
      ref: "HEAD",
    });
    const details = result.details as Record<string, unknown>;
    expect(details.ref).toBe("HEAD");
  });

  it("lists remotes", async () => {
    const result = await tool.execute("call-6", { action: "remote", cwd });
    const details = result.details as Record<string, unknown>;
    expect(details.count).toBeGreaterThan(0);
  });

  it("lists stashes", async () => {
    const result = await tool.execute("call-7", {
      action: "stash",
      stashAction: "list",
      cwd,
    });
    const details = result.details as Record<string, unknown>;
    expect(typeof details.count).toBe("number");
  });
});
