import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTmuxTool } from "./tmux-tool.js";

function hasTmux(): boolean {
  try {
    execFileSync("tmux", ["-V"], { timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

const SKIP = !hasTmux() || os.platform() === "win32";

describe("tmux tool", () => {
  const tool = createTmuxTool();

  it("has correct name and schema", () => {
    expect(tool.name).toBe("tmux");
    expect(tool.parameters).toBeDefined();
  });

  describe.skipIf(SKIP)("with tmux available", () => {
    const socketDir = path.join(os.tmpdir(), `openclaw-tmux-test-${process.pid}`);
    const socket = path.join(socketDir, "test.sock");
    const testSession = `test-${process.pid}`;

    beforeAll(() => {
      fs.mkdirSync(socketDir, { recursive: true });
    });

    afterAll(() => {
      try {
        execFileSync("tmux", ["-S", socket, "kill-server"], { timeout: 3000 });
      } catch {
        // server may not exist
      }
      try {
        fs.rmSync(socketDir, { recursive: true, force: true });
      } catch {
        // cleanup best-effort
      }
    });

    it("creates a new session", async () => {
      const result = await tool.execute("call-1", {
        action: "new_session",
        session: testSession,
        socket,
      });
      const details = result.details as Record<string, unknown>;
      expect(details.ok).toBe(true);
      expect(details.session).toBe(testSession);
      expect(details.socket).toBe(socket);
    });

    it("lists sessions", async () => {
      const result = await tool.execute("call-2", {
        action: "list_sessions",
        socket,
      });
      const details = result.details as Record<string, unknown>;
      const sessions = details.sessions as Array<Record<string, unknown>>;
      expect(sessions.length).toBeGreaterThan(0);
      expect(sessions.some((s) => s.name === testSession)).toBe(true);
    });

    it("checks if session exists", async () => {
      const result = await tool.execute("call-3", {
        action: "has_session",
        session: testSession,
        socket,
      });
      const details = result.details as Record<string, unknown>;
      expect(details.exists).toBe(true);
    });

    it("sends keys and captures output", async () => {
      await tool.execute("call-4", {
        action: "send_keys",
        session: testSession,
        command: "echo tmux-test-output",
        socket,
      });

      // Give it a moment to process
      await new Promise((r) => setTimeout(r, 500));

      const result = await tool.execute("call-5", {
        action: "capture",
        session: testSession,
        lines: 50,
        socket,
      });
      const text = result.content?.[0];
      expect(text).toBeDefined();
      if (text && "text" in text) {
        expect(text.text).toContain("tmux-test-output");
      }
    });

    it("lists panes", async () => {
      const result = await tool.execute("call-6", {
        action: "list_panes",
        socket,
      });
      const details = result.details as Record<string, unknown>;
      const panes = details.panes as Array<Record<string, unknown>>;
      expect(panes.length).toBeGreaterThan(0);
    });

    it("kills a session", async () => {
      const result = await tool.execute("call-7", {
        action: "kill_session",
        session: testSession,
        socket,
      });
      const details = result.details as Record<string, unknown>;
      expect(details.ok).toBe(true);

      // Verify it's gone
      const check = await tool.execute("call-8", {
        action: "has_session",
        session: testSession,
        socket,
      });
      expect((check.details as Record<string, unknown>).exists).toBe(false);
    });

    it("handles list_sessions on empty server gracefully", async () => {
      const emptySocket = path.join(socketDir, "empty.sock");
      const result = await tool.execute("call-9", {
        action: "list_sessions",
        socket: emptySocket,
      });
      const details = result.details as Record<string, unknown>;
      const sessions = details.sessions as unknown[];
      expect(sessions).toHaveLength(0);
    });
  });
});
