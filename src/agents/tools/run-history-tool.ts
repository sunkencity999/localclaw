import { Type } from "@sinclair/typebox";
import { clearRunHistory, getRunEntry, queryRunHistory, runHistoryStats } from "../run-history.js";
import { optionalStringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult } from "./common.js";

const RUN_HISTORY_ACTIONS = ["list", "detail", "stats", "clear"] as const;
const STATUS_FILTERS = ["completed", "failed", "killed"] as const;

const RunHistorySchema = Type.Object({
  action: optionalStringEnum(RUN_HISTORY_ACTIONS),
  id: Type.Optional(Type.String({ description: "Session ID for detail action" })),
  limit: Type.Optional(Type.Number({ description: "Max entries to return (default 20, max 100)" })),
  status: optionalStringEnum(STATUS_FILTERS),
  search: Type.Optional(Type.String({ description: "Search in command, cwd, or output" })),
  sinceMinutesAgo: Type.Optional(
    Type.Number({ description: "Only show runs from the last N minutes" }),
  ),
});

export function createRunHistoryTool(): AnyAgentTool {
  return {
    label: "Run History",
    name: "run_history",
    description: [
      "Query the persistent history of all exec'd commands.",
      "Actions: list (search/filter recent runs), detail (get full info for a run by ID),",
      "stats (summary counts), clear (wipe history).",
      "Default action is list.",
    ].join(" "),
    parameters: RunHistorySchema,
    execute: async (_toolCallId, args) => {
      const params = (args ?? {}) as Record<string, unknown>;
      const action =
        typeof params.action === "string" && params.action.trim() ? params.action.trim() : "list";

      switch (action) {
        case "detail": {
          const id = typeof params.id === "string" ? params.id.trim() : undefined;
          if (!id) {
            throw new Error("id required for detail action");
          }
          const entry = getRunEntry(id);
          if (!entry) {
            return jsonResult({ error: `No run found with id: ${id}` });
          }
          return jsonResult(entry);
        }

        case "stats":
          return jsonResult(runHistoryStats());

        case "clear":
          await clearRunHistory();
          return jsonResult({ ok: true, message: "Run history cleared" });

        case "list":
        default: {
          const limit =
            typeof params.limit === "number" && Number.isFinite(params.limit)
              ? Math.max(1, Math.min(100, Math.trunc(params.limit)))
              : 20;
          const status = typeof params.status === "string" ? params.status.trim() : undefined;
          const search =
            typeof params.search === "string" && params.search.trim()
              ? params.search.trim()
              : undefined;
          const sinceMinutesAgo =
            typeof params.sinceMinutesAgo === "number" && Number.isFinite(params.sinceMinutesAgo)
              ? params.sinceMinutesAgo
              : undefined;
          const since = sinceMinutesAgo ? Date.now() - sinceMinutesAgo * 60 * 1000 : undefined;

          const entries = queryRunHistory({ limit, status, search, since });
          // Return a compact summary for list view
          const results = entries.map((e) => ({
            id: e.id,
            command: e.command.length > 120 ? `${e.command.slice(0, 117)}...` : e.command,
            status: e.status,
            exitCode: e.exitCode,
            durationMs: e.durationMs,
            cwd: e.cwd,
            startedAt: new Date(e.startedAt).toISOString(),
          }));
          return jsonResult({ count: results.length, runs: results });
        }
      }
    },
  };
}
