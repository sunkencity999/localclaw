import { Type } from "@sinclair/typebox";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { optionalStringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";

const execFileAsync = promisify(execFile);

const GIT_ACTIONS = [
  "status",
  "log",
  "diff",
  "branch",
  "stash",
  "show",
  "blame",
  "remote",
] as const;

const GitToolSchema = Type.Object({
  action: optionalStringEnum(GIT_ACTIONS),
  cwd: Type.Optional(Type.String({ description: "Working directory (default: current)" })),
  ref: Type.Optional(
    Type.String({
      description: "Git ref: branch, tag, or commit hash (for log, diff, show, blame)",
    }),
  ),
  ref2: Type.Optional(
    Type.String({ description: "Second ref for diff comparison (e.g. diff ref..ref2)" }),
  ),
  path: Type.Optional(
    Type.String({ description: "File path filter (for diff, blame, log, show)" }),
  ),
  maxCount: Type.Optional(Type.Number({ description: "Max entries for log (default 20)" })),
  format: Type.Optional(
    Type.String({
      description:
        "Log format: oneline, short, medium, full, fuller, or custom format string (default: oneline)",
    }),
  ),
  stashAction: Type.Optional(
    Type.String({
      description: "Stash sub-action: list, show, push, pop, drop (default: list)",
    }),
  ),
  message: Type.Optional(Type.String({ description: "Message for stash push" })),
  staged: Type.Optional(
    Type.Boolean({ description: "Show only staged changes in diff (default: false)" }),
  ),
});

const MAX_OUTPUT = 50_000;

async function git(
  args: string[],
  cwd?: string,
  timeoutMs = 30_000,
): Promise<{ stdout: string; stderr: string }> {
  const opts: Record<string, unknown> = {
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024,
  };
  if (cwd) opts.cwd = cwd;
  return execFileAsync("git", args, opts);
}

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT) return text;
  return `${text.slice(0, MAX_OUTPUT)}\n... [truncated, ${text.length} chars total]`;
}

export function createGitTool(): AnyAgentTool {
  return {
    label: "Git",
    name: "git",
    description: [
      "Structured git operations (read-only). Provides status, log, diff, branch,",
      "stash, show, blame, and remote info without composing raw shell commands.",
      "All operations are safe read-only queries except stash push/pop/drop.",
    ].join(" "),
    parameters: GitToolSchema,
    execute: async (_toolCallId, args) => {
      const params = (args ?? {}) as Record<string, unknown>;
      const action =
        typeof params.action === "string" && params.action.trim() ? params.action.trim() : "status";
      const cwd =
        typeof params.cwd === "string" && params.cwd.trim() ? params.cwd.trim() : undefined;

      switch (action) {
        case "status": {
          const { stdout } = await git(["status", "--short", "--branch"], cwd);
          const { stdout: stashList } = await git(["stash", "list"], cwd).catch(() => ({
            stdout: "",
          }));

          // Parse branch info from first line
          const lines = stdout.split("\n");
          const branchLine = lines[0] ?? "";
          const fileLines = lines.slice(1).filter((l) => l.trim());

          return {
            content: [{ type: "text", text: truncate(stdout) }],
            details: {
              branch: branchLine.replace(/^## /, ""),
              changedFiles: fileLines.length,
              stashCount: stashList.trim() ? stashList.trim().split("\n").length : 0,
            },
          };
        }

        case "log": {
          const maxCount =
            typeof params.maxCount === "number" && Number.isFinite(params.maxCount)
              ? Math.max(1, Math.min(200, Math.trunc(params.maxCount)))
              : 20;
          const format =
            typeof params.format === "string" && params.format.trim()
              ? params.format.trim()
              : "oneline";

          const gitArgs = ["log", `--max-count=${maxCount}`];

          // Map named formats or pass custom
          const namedFormats: Record<string, string> = {
            oneline: "%h %s (%cr) <%an>",
            short: "%h %s%n  Author: %an <%ae>%n  Date: %cr%n",
            medium: "%H%n  Author: %an <%ae>%n  Date: %ci%n%n  %s%n%n%b",
          };
          if (namedFormats[format]) {
            gitArgs.push(`--format=${namedFormats[format]}`);
          } else if (format === "full" || format === "fuller") {
            gitArgs.push(`--format=${format}`);
          } else {
            gitArgs.push(`--format=${format}`);
          }

          if (typeof params.ref === "string" && params.ref.trim()) {
            gitArgs.push(params.ref.trim());
          }
          if (typeof params.path === "string" && params.path.trim()) {
            gitArgs.push("--", params.path.trim());
          }

          const { stdout } = await git(gitArgs, cwd);
          return {
            content: [{ type: "text", text: truncate(stdout) }],
            details: { entries: stdout.trim().split("\n").filter(Boolean).length },
          };
        }

        case "diff": {
          const gitArgs = ["diff"];
          if (params.staged === true) {
            gitArgs.push("--staged");
          }
          if (typeof params.ref === "string" && params.ref.trim()) {
            if (typeof params.ref2 === "string" && params.ref2.trim()) {
              gitArgs.push(`${params.ref.trim()}..${params.ref2.trim()}`);
            } else {
              gitArgs.push(params.ref.trim());
            }
          }
          gitArgs.push("--stat");
          if (typeof params.path === "string" && params.path.trim()) {
            gitArgs.push("--", params.path.trim());
          }

          const { stdout: stat } = await git(gitArgs, cwd);

          // Also get the actual diff (limited)
          const diffArgs = gitArgs.filter((a) => a !== "--stat");
          const { stdout: diff } = await git(diffArgs, cwd);

          return {
            content: [{ type: "text", text: truncate(`${stat}\n---\n${diff}`) }],
            details: {
              statsLines: stat.trim().split("\n").length,
              diffLines: diff.trim().split("\n").length,
            },
          };
        }

        case "branch": {
          const { stdout: local } = await git(["branch", "-v", "--no-color"], cwd);
          const { stdout: remote } = await git(["branch", "-rv", "--no-color"], cwd).catch(() => ({
            stdout: "",
          }));

          const localBranches = local
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => {
              const current = line.startsWith("*");
              const trimmed = line.replace(/^\*?\s+/, "").trim();
              const parts = trimmed.split(/\s+/);
              return {
                name: parts[0],
                hash: parts[1],
                current,
                message: parts.slice(2).join(" "),
              };
            });

          return {
            content: [
              {
                type: "text",
                text: `Local:\n${local}\nRemote:\n${remote}`,
              },
            ],
            details: {
              localCount: localBranches.length,
              current: localBranches.find((b) => b.current)?.name,
              branches: localBranches,
            },
          };
        }

        case "stash": {
          const stashAction =
            typeof params.stashAction === "string" && params.stashAction.trim()
              ? params.stashAction.trim()
              : "list";

          switch (stashAction) {
            case "list": {
              const { stdout } = await git(["stash", "list"], cwd);
              return {
                content: [{ type: "text", text: stdout || "(no stashes)" }],
                details: {
                  count: stdout.trim() ? stdout.trim().split("\n").length : 0,
                },
              };
            }
            case "show": {
              const ref =
                typeof params.ref === "string" && params.ref.trim()
                  ? params.ref.trim()
                  : "stash@{0}";
              const { stdout } = await git(["stash", "show", "-p", ref], cwd);
              return {
                content: [{ type: "text", text: truncate(stdout) }],
                details: { ref },
              };
            }
            case "push": {
              const gitArgs = ["stash", "push"];
              if (typeof params.message === "string" && params.message.trim()) {
                gitArgs.push("-m", params.message.trim());
              }
              const { stdout } = await git(gitArgs, cwd);
              return {
                content: [{ type: "text", text: stdout }],
                details: { action: "push" },
              };
            }
            case "pop": {
              const { stdout } = await git(["stash", "pop"], cwd);
              return {
                content: [{ type: "text", text: stdout }],
                details: { action: "pop" },
              };
            }
            case "drop": {
              const ref =
                typeof params.ref === "string" && params.ref.trim()
                  ? params.ref.trim()
                  : "stash@{0}";
              const { stdout } = await git(["stash", "drop", ref], cwd);
              return {
                content: [{ type: "text", text: stdout }],
                details: { action: "drop", ref },
              };
            }
            default:
              throw new Error(`Unknown stash action: ${stashAction}`);
          }
        }

        case "show": {
          const ref =
            typeof params.ref === "string" && params.ref.trim() ? params.ref.trim() : "HEAD";
          const gitArgs = ["show", "--stat", ref];
          if (typeof params.path === "string" && params.path.trim()) {
            gitArgs.push("--", params.path.trim());
          }

          const { stdout } = await git(gitArgs, cwd);
          return {
            content: [{ type: "text", text: truncate(stdout) }],
            details: { ref },
          };
        }

        case "blame": {
          const filePath = readStringParam(params, "path", { required: true });
          const gitArgs = ["blame", "--porcelain", filePath];
          if (typeof params.ref === "string" && params.ref.trim()) {
            gitArgs.splice(1, 0, params.ref.trim());
          }

          const { stdout } = await git(gitArgs, cwd);

          // Parse porcelain blame into readable format
          const lines: string[] = [];
          const entries = stdout.split("\n");
          let currentHash = "";
          let currentAuthor = "";
          let currentLine = "";

          for (const entry of entries) {
            if (entry.match(/^[0-9a-f]{40}/)) {
              const parts = entry.split(" ");
              currentHash = parts[0].slice(0, 8);
            } else if (entry.startsWith("author ")) {
              currentAuthor = entry.slice(7);
            } else if (entry.startsWith("\t")) {
              currentLine = entry.slice(1);
              lines.push(`${currentHash} (${currentAuthor}) ${currentLine}`);
            }
          }

          return {
            content: [{ type: "text", text: truncate(lines.join("\n")) }],
            details: { path: filePath, lineCount: lines.length },
          };
        }

        case "remote": {
          const { stdout } = await git(["remote", "-v"], cwd);
          const remotes = stdout
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => {
              const parts = line.split(/\s+/);
              return { name: parts[0], url: parts[1], type: parts[2]?.replace(/[()]/g, "") };
            });

          // Deduplicate (fetch/push pairs)
          const unique = new Map<string, { name: string; url: string }>();
          for (const r of remotes) {
            if (!unique.has(r.name)) {
              unique.set(r.name, { name: r.name, url: r.url });
            }
          }

          return jsonResult({
            remotes: Array.from(unique.values()),
            count: unique.size,
          });
        }

        default:
          throw new Error(`Unknown git action: ${action}`);
      }
    },
  };
}
