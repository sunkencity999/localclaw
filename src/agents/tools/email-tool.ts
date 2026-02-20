import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { optionalStringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam, readNumberParam } from "./common.js";

const EMAIL_ACTIONS = [
  "search",
  "read_message",
  "send",
  "reply",
  "archive",
  "modify_labels",
  "list_labels",
  "list_accounts",
] as const;

const EmailToolSchema = Type.Object({
  action: optionalStringEnum(EMAIL_ACTIONS),
  account: Type.Optional(
    Type.String({
      description:
        "Gmail address or account label (e.g. 'home', 'work') to use. Defaults to the configured default account.",
    }),
  ),
  query: Type.Optional(
    Type.String({
      description:
        "Gmail search query (e.g. 'from:boss@company.com is:unread', 'subject:invoice newer_than:7d')",
    }),
  ),
  messageId: Type.Optional(Type.String({ description: "Gmail message ID (from search results)" })),
  to: Type.Optional(Type.String({ description: "Recipient email addresses (comma-separated)" })),
  cc: Type.Optional(Type.String({ description: "CC recipients (comma-separated)" })),
  subject: Type.Optional(Type.String({ description: "Email subject line" })),
  body: Type.Optional(Type.String({ description: "Email body (plain text)" })),
  threadId: Type.Optional(
    Type.String({ description: "Thread ID to reply within (from search results)" }),
  ),
  replyAll: Type.Optional(
    Type.Boolean({ description: "Reply to all recipients (default: false)" }),
  ),
  maxResults: Type.Optional(
    Type.Number({ description: "Max search results (default: 10, max: 50)" }),
  ),
  addLabels: Type.Optional(
    Type.String({
      description: "Comma-separated label names or IDs to add (for archive/modify_labels actions)",
    }),
  ),
  removeLabels: Type.Optional(
    Type.String({
      description:
        "Comma-separated label names or IDs to remove (for modify_labels action; archive always removes INBOX)",
    }),
  ),
});

type EmailAccount = { address: string; label?: string; client?: string };

type EmailConfig = {
  accounts: EmailAccount[];
  defaultAccount: string;
  timeoutMs: number;
};

function resolveEmailConfig(config?: OpenClawConfig): EmailConfig | null {
  const emailCfg = config?.integrations?.email;
  if (!emailCfg?.enabled) return null;
  const accounts = emailCfg.accounts ?? [];
  if (accounts.length === 0) return null;
  const defaultAccount = emailCfg.defaultAccount ?? accounts[0]?.address ?? "";
  if (!defaultAccount) return null;
  const timeoutMs = (emailCfg.timeoutSeconds ?? 30) * 1000;
  return { accounts, defaultAccount, timeoutMs };
}

function resolveAccountEntry(cfg: EmailConfig, accountInput?: string): EmailAccount {
  const fallback: EmailAccount = { address: accountInput?.trim() || cfg.defaultAccount };
  const haystack = cfg.accounts;
  if (!accountInput) {
    return haystack.find((a) => a.address === cfg.defaultAccount) ?? fallback;
  }
  const trimmed = accountInput.trim().toLowerCase();
  const byLabel = haystack.find((a) => a.label?.toLowerCase() === trimmed);
  if (byLabel) return byLabel;
  const byAddress = haystack.find((a) => a.address.toLowerCase() === trimmed);
  if (byAddress) return byAddress;
  const byPartial = haystack.find(
    (a) =>
      a.address.toLowerCase().startsWith(trimmed) || a.label?.toLowerCase().startsWith(trimmed),
  );
  if (byPartial) return byPartial;
  return fallback;
}

function accountArgs(entry: EmailAccount): string[] {
  const args = ["--account", entry.address];
  if (entry.client) args.push("--client", entry.client);
  return args;
}

async function runGog(
  args: string[],
  timeoutMs: number,
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  try {
    const result = await runCommandWithTimeout(["gog", ...args], { timeoutMs });
    if (result.code !== 0) {
      const msg = (result.stderr || result.stdout || "gog command failed").trim();
      return { ok: false, error: msg };
    }
    const stdout = result.stdout.trim();
    if (!stdout) return { ok: true, data: null };
    try {
      return { ok: true, data: JSON.parse(stdout) };
    } catch {
      return { ok: true, data: stdout };
    }
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

function truncateBody(text: string, maxChars = 4000): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n... [truncated, ${text.length - maxChars} chars omitted]`;
}

async function executeEmailAction(cfg: EmailConfig, params: Record<string, unknown>) {
  const action = readStringParam(params, "action", { required: true });
  const accountInput = readStringParam(params, "account");

  switch (action) {
    case "list_accounts": {
      const lines = cfg.accounts.map((a) => {
        const isDefault = a.address === cfg.defaultAccount ? " (default)" : "";
        const label = a.label ? ` [${a.label}]` : "";
        return `${a.address}${label}${isDefault}`;
      });
      return {
        content: [
          { type: "text" as const, text: `Configured email accounts:\n${lines.join("\n")}` },
        ],
        details: { accounts: cfg.accounts },
      };
    }

    case "search": {
      const query = readStringParam(params, "query", { required: true });
      const maxResults = Math.min(
        readNumberParam(params, "maxResults", { integer: true }) ?? 10,
        50,
      );
      const entry = resolveAccountEntry(cfg, accountInput);
      const result = await runGog(
        ["gmail", "search", query, ...accountArgs(entry), "--max", String(maxResults), "--json"],
        cfg.timeoutMs,
      );
      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: `Search failed: ${result.error}` }],
          details: { error: result.error },
        };
      }
      const data = result.data;
      if (!data || (Array.isArray(data) && data.length === 0)) {
        return {
          content: [
            { type: "text" as const, text: `No results for: ${query} (account: ${entry.address})` },
          ],
          details: { account: entry.address, query, count: 0 },
        };
      }
      return jsonResult({
        content: [
          { type: "text", text: `Search results for "${query}" (account: ${entry.address}):` },
        ],
        details: { account: entry.address, query, results: data },
      });
    }

    case "read_message": {
      const messageId = readStringParam(params, "messageId", { required: true });
      const entry = resolveAccountEntry(cfg, accountInput);
      const result = await runGog(
        ["gmail", "get", messageId, ...accountArgs(entry), "--format", "full", "--json"],
        cfg.timeoutMs,
      );
      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: `Read failed: ${result.error}` }],
          details: { error: result.error },
        };
      }
      const msg = result.data as Record<string, unknown> | null;
      if (!msg) {
        return {
          content: [{ type: "text" as const, text: `Message ${messageId} not found.` }],
          details: { messageId, found: false },
        };
      }
      if (typeof msg.body === "string") msg.body = truncateBody(msg.body);
      if (typeof msg.bodyHtml === "string") msg.bodyHtml = truncateBody(msg.bodyHtml);
      return jsonResult({
        content: [{ type: "text", text: `Message ${messageId} (account: ${entry.address}):` }],
        details: { account: entry.address, message: msg },
      });
    }

    case "send": {
      const to = readStringParam(params, "to", { required: true });
      const subject = readStringParam(params, "subject", { required: true });
      const body = readStringParam(params, "body", { required: true });
      const cc = readStringParam(params, "cc");
      const entry = resolveAccountEntry(cfg, accountInput);

      const args = [
        "gmail",
        "send",
        ...accountArgs(entry),
        "--to",
        to,
        "--subject",
        subject,
        "--body",
        body,
        "--force",
        "--no-input",
        "--json",
      ];
      if (cc) args.push("--cc", cc);

      const result = await runGog(args, cfg.timeoutMs);
      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: `Send failed: ${result.error}` }],
          details: { error: result.error },
        };
      }
      return jsonResult({
        content: [
          { type: "text", text: `Email sent from ${entry.address} to ${to}: "${subject}"` },
        ],
        details: { account: entry.address, to, subject, result: result.data },
      });
    }

    case "reply": {
      const body = readStringParam(params, "body", { required: true });
      const messageId = readStringParam(params, "messageId");
      const threadId = readStringParam(params, "threadId");
      const replyAll = params.replyAll === true;
      const entry = resolveAccountEntry(cfg, accountInput);

      if (!messageId && !threadId) {
        return {
          content: [
            {
              type: "text" as const,
              text: "reply requires either messageId or threadId to identify the conversation.",
            },
          ],
          details: { error: "missing messageId or threadId" },
        };
      }

      const args = [
        "gmail",
        "send",
        ...accountArgs(entry),
        "--body",
        body,
        "--force",
        "--no-input",
        "--json",
      ];
      if (messageId) args.push("--reply-to-message-id", messageId);
      if (threadId && !messageId) args.push("--thread-id", threadId);
      if (replyAll) args.push("--reply-all");
      const to = readStringParam(params, "to");
      if (to) args.push("--to", to);
      const subject = readStringParam(params, "subject");
      if (subject) args.push("--subject", subject);

      const result = await runGog(args, cfg.timeoutMs);
      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: `Reply failed: ${result.error}` }],
          details: { error: result.error },
        };
      }
      return jsonResult({
        content: [
          {
            type: "text",
            text: `Reply sent from ${entry.address}${replyAll ? " (reply-all)" : ""}: ${messageId ?? threadId}`,
          },
        ],
        details: { account: entry.address, messageId, threadId, replyAll, result: result.data },
      });
    }

    case "archive": {
      const threadId = readStringParam(params, "threadId", { required: true });
      const addLabels = readStringParam(params, "addLabels");
      const entry = resolveAccountEntry(cfg, accountInput);

      const threadIds = threadId.split(/[,\s]+/).filter(Boolean);
      const results: Array<{ threadId: string; ok: boolean; error?: string }> = [];

      for (const tid of threadIds) {
        const args = [
          "gmail",
          "thread",
          "modify",
          tid,
          ...accountArgs(entry),
          "--remove",
          "INBOX",
          "--force",
          "--no-input",
          "--json",
        ];
        if (addLabels) args.splice(args.indexOf("--remove"), 0, "--add", addLabels);

        const result = await runGog(args, cfg.timeoutMs);
        results.push({ threadId: tid, ok: result.ok, ...(!result.ok && { error: result.error }) });
      }

      const allOk = results.every((r) => r.ok);
      const summary = allOk
        ? `Archived ${results.length} thread(s) from ${entry.address}${addLabels ? ` (added labels: ${addLabels})` : ""}`
        : `Archived ${results.filter((r) => r.ok).length}/${results.length} threads; some failed`;

      return jsonResult({
        content: [{ type: "text", text: summary }],
        details: { account: entry.address, results },
      });
    }

    case "modify_labels": {
      const threadId = readStringParam(params, "threadId", { required: true });
      const addLabels = readStringParam(params, "addLabels");
      const removeLabels = readStringParam(params, "removeLabels");
      const entry = resolveAccountEntry(cfg, accountInput);

      if (!addLabels && !removeLabels) {
        return {
          content: [
            {
              type: "text" as const,
              text: "modify_labels requires at least one of addLabels or removeLabels.",
            },
          ],
          details: { error: "missing addLabels or removeLabels" },
        };
      }

      const threadIds = threadId.split(/[,\s]+/).filter(Boolean);
      const results: Array<{ threadId: string; ok: boolean; error?: string }> = [];

      for (const tid of threadIds) {
        const args = [
          "gmail",
          "thread",
          "modify",
          tid,
          ...accountArgs(entry),
          "--force",
          "--no-input",
          "--json",
        ];
        if (addLabels) args.push("--add", addLabels);
        if (removeLabels) args.push("--remove", removeLabels);

        const result = await runGog(args, cfg.timeoutMs);
        results.push({ threadId: tid, ok: result.ok, ...(!result.ok && { error: result.error }) });
      }

      const allOk = results.every((r) => r.ok);
      const parts: string[] = [];
      if (addLabels) parts.push(`+${addLabels}`);
      if (removeLabels) parts.push(`-${removeLabels}`);
      const summary = allOk
        ? `Modified ${results.length} thread(s) [${parts.join(", ")}] (account: ${entry.address})`
        : `Modified ${results.filter((r) => r.ok).length}/${results.length} threads; some failed`;

      return jsonResult({
        content: [{ type: "text", text: summary }],
        details: { account: entry.address, results },
      });
    }

    case "list_labels": {
      const entry = resolveAccountEntry(cfg, accountInput);
      const result = await runGog(
        ["gmail", "labels", "list", ...accountArgs(entry), "--json"],
        cfg.timeoutMs,
      );
      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: `List labels failed: ${result.error}` }],
          details: { error: result.error },
        };
      }
      return jsonResult({
        content: [{ type: "text", text: `Labels for ${entry.address}:` }],
        details: { account: entry.address, labels: result.data },
      });
    }

    default:
      return {
        content: [
          {
            type: "text" as const,
            text: `Unknown action: ${action}. Available: ${EMAIL_ACTIONS.join(", ")}`,
          },
        ],
        details: { error: `unknown action: ${action}` },
      };
  }
}

export function createEmailTool(options?: { config?: OpenClawConfig }): AnyAgentTool | null {
  const cfg = resolveEmailConfig(options?.config);
  if (!cfg) return null;

  const accountList = cfg.accounts
    .map((a) => `${a.address}${a.label ? ` (${a.label})` : ""}`)
    .join(", ");

  return {
    label: "Email",
    name: "email",
    description: [
      "PREFERRED tool for ALL email operations — use this instead of exec/shell for email tasks.",
      "Gmail integration for reading, sending, labeling, and archiving email.",
      `Configured accounts: ${accountList}. Default: ${cfg.defaultAccount}.`,
      "Actions: search, read_message, send, reply, archive, modify_labels, list_labels, list_accounts.",
      "WORKFLOW: (1) search returns message summaries with threadId and messageId.",
      "(2) Use read_message with a messageId from search results to get the FULL email content (subject, body, headers, attachments).",
      "Always use read_message when the user asks to open, read, or view an email — search alone only returns summaries.",
      "(3) archive removes messages from Inbox (removes INBOX label). Pass threadId (comma-separated for bulk). Optionally set addLabels to label at the same time.",
      "(4) modify_labels adds/removes arbitrary labels on thread(s). Pass threadId + addLabels and/or removeLabels (comma-separated label names).",
      "Use the 'account' parameter to specify which account (by address or label).",
      "Do NOT use the exec tool to run gog commands directly — always use this email tool instead.",
    ].join(" "),
    parameters: EmailToolSchema,
    execute: async (_toolCallId, args) => {
      const params = (args ?? {}) as Record<string, unknown>;
      return executeEmailAction(cfg, params);
    },
  };
}
