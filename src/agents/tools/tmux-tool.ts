import { Type } from "@sinclair/typebox";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { optionalStringEnum, stringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";

const execFileAsync = promisify(execFile);

const TMUX_ACTIONS = [
  "new_session",
  "send_keys",
  "capture",
  "list_sessions",
  "list_panes",
  "kill_session",
  "kill_server",
  "has_session",
  "wait_for_text",
] as const;

const TmuxToolSchema = Type.Object({
  action: stringEnum(TMUX_ACTIONS),
  session: Type.Optional(Type.String({ description: "Session name" })),
  target: Type.Optional(
    Type.String({ description: "Pane target (session:window.pane), e.g. mysess:0.0" }),
  ),
  command: Type.Optional(
    Type.String({ description: "Initial command for new_session, or keys to send" }),
  ),
  literal: Type.Optional(
    Type.Boolean({
      description: "If true, send keys literally (-l flag). Default true for safety.",
    }),
  ),
  window: Type.Optional(Type.String({ description: "Window name for new_session" })),
  lines: Type.Optional(Type.Number({ description: "History lines to capture (default 200)" })),
  pattern: Type.Optional(Type.String({ description: "Regex pattern for wait_for_text" })),
  timeoutSec: Type.Optional(
    Type.Number({ description: "Timeout in seconds for wait_for_text (default 15)" }),
  ),
  pollIntervalSec: Type.Optional(
    Type.Number({ description: "Poll interval for wait_for_text (default 0.5)" }),
  ),
  socket: Type.Optional(Type.String({ description: "Custom socket path (default: auto-managed)" })),
  env: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description: "Environment variables to set in the new session",
    }),
  ),
});

function resolveSocketDir(): string {
  return (
    process.env.OPENCLAW_TMUX_SOCKET_DIR ??
    process.env.CLAWDBOT_TMUX_SOCKET_DIR ??
    path.join(os.tmpdir(), "openclaw-tmux-sockets")
  );
}

function resolveSocket(custom?: string): string {
  if (custom?.trim()) return custom.trim();
  const dir = resolveSocketDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return path.join(dir, "openclaw.sock");
}

async function tmux(socket: string, args: string[], timeoutMs = 10_000): Promise<string> {
  const { stdout } = await execFileAsync("tmux", ["-S", socket, ...args], {
    timeout: timeoutMs,
    env: { ...process.env, TERM: process.env.TERM ?? "xterm-256color" },
  });
  return stdout;
}

function resolveTarget(params: Record<string, unknown>): string {
  const target = typeof params.target === "string" ? params.target.trim() : "";
  if (target) return target;
  const session = typeof params.session === "string" ? params.session.trim() : "";
  if (session) return `${session}:0.0`;
  throw new Error("session or target required");
}

async function waitForText(
  socket: string,
  target: string,
  pattern: string,
  timeoutSec: number,
  pollIntervalSec: number,
  lines: number,
): Promise<{ matched: boolean; output: string; elapsed: number }> {
  const regex = new RegExp(pattern);
  const start = Date.now();
  const deadlineMs = timeoutSec * 1000;
  const intervalMs = pollIntervalSec * 1000;

  while (Date.now() - start < deadlineMs) {
    try {
      const output = await tmux(socket, [
        "capture-pane",
        "-p",
        "-J",
        "-t",
        target,
        "-S",
        `-${lines}`,
      ]);
      if (regex.test(output)) {
        return { matched: true, output: output.trim(), elapsed: Date.now() - start };
      }
    } catch {
      // pane might not exist yet, keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  // Final capture attempt
  let finalOutput = "";
  try {
    finalOutput = await tmux(socket, ["capture-pane", "-p", "-J", "-t", target, "-S", `-${lines}`]);
  } catch {
    // ignore
  }
  return {
    matched: false,
    output: finalOutput.trim(),
    elapsed: Date.now() - start,
  };
}

export function createTmuxTool(): AnyAgentTool {
  return {
    label: "tmux",
    name: "tmux",
    description: [
      "Manage tmux sessions for interactive CLIs and long-running processes.",
      "Actions: new_session, send_keys, capture, list_sessions, list_panes,",
      "kill_session, kill_server, has_session, wait_for_text.",
      "Uses an isolated socket so sessions don't collide with the user's tmux.",
      "Requires tmux on PATH (macOS/Linux only).",
    ].join(" "),
    parameters: TmuxToolSchema,
    execute: async (_toolCallId, args) => {
      const params = (args ?? {}) as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const socket = resolveSocket(typeof params.socket === "string" ? params.socket : undefined);

      switch (action) {
        case "new_session": {
          const session =
            typeof params.session === "string" && params.session.trim()
              ? params.session.trim()
              : `openclaw-${Date.now().toString(36)}`;
          const window =
            typeof params.window === "string" && params.window.trim()
              ? params.window.trim()
              : "shell";

          const tmuxArgs = ["new-session", "-d", "-s", session, "-n", window];

          // Set environment variables if provided
          if (params.env && typeof params.env === "object") {
            for (const [key, value] of Object.entries(params.env as Record<string, string>)) {
              tmuxArgs.push("-e", `${key}=${value}`);
            }
          }

          await tmux(socket, tmuxArgs);

          // Send initial command if provided
          if (typeof params.command === "string" && params.command.trim()) {
            await tmux(socket, [
              "send-keys",
              "-t",
              `${session}:0.0`,
              "-l",
              "--",
              params.command.trim(),
            ]);
            await tmux(socket, ["send-keys", "-t", `${session}:0.0`, "Enter"]);
          }

          return jsonResult({
            ok: true,
            session,
            window,
            socket,
            target: `${session}:0.0`,
            monitor: `tmux -S "${socket}" attach -t ${session}`,
          });
        }

        case "send_keys": {
          const target = resolveTarget(params);
          const keys = typeof params.command === "string" ? params.command : undefined;
          if (!keys) {
            throw new Error("command (keys to send) required for send_keys");
          }
          const literal = params.literal !== false; // default true for safety
          const sendArgs = ["send-keys", "-t", target];
          if (literal) sendArgs.push("-l");
          sendArgs.push("--", keys);
          await tmux(socket, sendArgs);

          // If we sent literal keys, also send Enter unless the keys end with special control sequences
          if (literal && !keys.endsWith("\n")) {
            await tmux(socket, ["send-keys", "-t", target, "Enter"]);
          }

          return jsonResult({ ok: true, target, keys, literal });
        }

        case "capture": {
          const target = resolveTarget(params);
          const lines =
            typeof params.lines === "number" && Number.isFinite(params.lines)
              ? Math.max(1, Math.min(10000, Math.trunc(params.lines)))
              : 200;

          const output = await tmux(socket, [
            "capture-pane",
            "-p",
            "-J",
            "-t",
            target,
            "-S",
            `-${lines}`,
          ]);

          return {
            content: [{ type: "text", text: output.trimEnd() }],
            details: { target, lines, length: output.length },
          };
        }

        case "list_sessions": {
          try {
            const output = await tmux(socket, [
              "list-sessions",
              "-F",
              "#{session_name}:#{session_windows}w:#{session_attached}a",
            ]);
            const sessions = output
              .trim()
              .split("\n")
              .filter(Boolean)
              .map((line) => {
                const [name, windows, attached] = line.split(":");
                return {
                  name,
                  windows: Number.parseInt(windows ?? "0", 10),
                  attached: (attached ?? "0") !== "0",
                };
              });
            return jsonResult({ socket, sessions });
          } catch {
            return jsonResult({
              socket,
              sessions: [],
              note: "No tmux server running on this socket",
            });
          }
        }

        case "list_panes": {
          try {
            const output = await tmux(socket, [
              "list-panes",
              "-a",
              "-F",
              "#{session_name}:#{window_index}.#{pane_index} #{pane_width}x#{pane_height} #{pane_current_command}",
            ]);
            const panes = output
              .trim()
              .split("\n")
              .filter(Boolean)
              .map((line) => {
                const [target, size, ...cmdParts] = line.split(" ");
                return { target, size, command: cmdParts.join(" ") };
              });
            return jsonResult({ socket, panes });
          } catch {
            return jsonResult({ socket, panes: [], note: "No tmux server running on this socket" });
          }
        }

        case "has_session": {
          const session = typeof params.session === "string" ? params.session.trim() : "";
          if (!session) throw new Error("session required for has_session");
          try {
            await tmux(socket, ["has-session", "-t", session]);
            return jsonResult({ exists: true, session });
          } catch {
            return jsonResult({ exists: false, session });
          }
        }

        case "kill_session": {
          const session = typeof params.session === "string" ? params.session.trim() : "";
          if (!session) throw new Error("session required for kill_session");
          try {
            await tmux(socket, ["kill-session", "-t", session]);
            return jsonResult({ ok: true, killed: session });
          } catch (err) {
            return jsonResult({
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        case "kill_server": {
          try {
            await tmux(socket, ["kill-server"]);
            return jsonResult({ ok: true, socket });
          } catch {
            return jsonResult({ ok: true, note: "Server was not running" });
          }
        }

        case "wait_for_text": {
          const target = resolveTarget(params);
          const pattern = typeof params.pattern === "string" ? params.pattern.trim() : "";
          if (!pattern) throw new Error("pattern required for wait_for_text");
          const timeoutSec =
            typeof params.timeoutSec === "number" && Number.isFinite(params.timeoutSec)
              ? Math.max(1, Math.min(120, params.timeoutSec))
              : 15;
          const pollIntervalSec =
            typeof params.pollIntervalSec === "number" && Number.isFinite(params.pollIntervalSec)
              ? Math.max(0.1, Math.min(10, params.pollIntervalSec))
              : 0.5;
          const lines =
            typeof params.lines === "number" && Number.isFinite(params.lines)
              ? Math.max(1, Math.min(10000, Math.trunc(params.lines)))
              : 1000;

          const result = await waitForText(
            socket,
            target,
            pattern,
            timeoutSec,
            pollIntervalSec,
            lines,
          );

          if (result.matched) {
            return {
              content: [{ type: "text", text: result.output }],
              details: {
                matched: true,
                elapsedMs: result.elapsed,
                pattern,
                target,
              },
            };
          }
          return {
            content: [
              {
                type: "text",
                text: result.output
                  ? `Timed out after ${timeoutSec}s. Last output:\n${result.output}`
                  : `Timed out after ${timeoutSec}s waiting for pattern: ${pattern}`,
              },
            ],
            details: {
              matched: false,
              elapsedMs: result.elapsed,
              pattern,
              target,
              timedOut: true,
            },
          };
        }

        default:
          throw new Error(`Unknown tmux action: ${action}`);
      }
    },
  };
}
