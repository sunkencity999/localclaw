import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { createSlackClient } from "../../integrations/slack.js";
import { optionalStringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam, readNumberParam } from "./common.js";

const SLACK_INTEGRATION_ACTIONS = [
  "post_message",
  "channel_history",
  "thread_replies",
  "read_dm",
  "list_dms",
  "find_user",
  "open_dm",
  "search_messages",
  "list_channels",
  "lookup_user",
  "add_reaction",
  "set_topic",
] as const;

const SlackIntegrationToolSchema = Type.Object({
  action: optionalStringEnum(SLACK_INTEGRATION_ACTIONS),
  channel: Type.Optional(Type.String({ description: "Channel name or ID" })),
  text: Type.Optional(Type.String({ description: "Message text to post" })),
  threadTs: Type.Optional(Type.String({ description: "Thread timestamp for replies" })),
  query: Type.Optional(Type.String({ description: "Search query" })),
  userId: Type.Optional(Type.String({ description: "User ID for lookup" })),
  emoji: Type.Optional(Type.String({ description: "Emoji name for reactions (without colons)" })),
  timestamp: Type.Optional(Type.String({ description: "Message timestamp for reactions" })),
  topic: Type.Optional(Type.String({ description: "Channel topic text" })),
  limit: Type.Optional(Type.Number({ description: "Max results (default varies by action)" })),
});

export function createSlackIntegrationTool(options?: {
  config?: OpenClawConfig;
}): AnyAgentTool | null {
  const slackConfig = options?.config?.integrations?.slack;
  if (!slackConfig?.enabled) {
    return null;
  }
  const client = createSlackClient(slackConfig);
  if (!client) {
    return null;
  }

  return {
    label: "Slack Integration",
    name: "slack_integration",
    description: [
      "Slack workspace integration.",
      "To find/read DMs with a SPECIFIC PERSON: use action=list_dms with query=their_username",
      "(e.g. query='ryan.valencia'). This searches the entire workspace and returns their DM",
      "messages directly — even if the DM is old. Without query, list_dms shows the 20 most",
      "recent DMs only. read_dm also works for this (same result).",
      "Other: post_message, channel_history, thread_replies, search_messages, list_channels,",
      "lookup_user, find_user, open_dm, add_reaction, set_topic.",
    ].join(" "),
    parameters: SlackIntegrationToolSchema,
    execute: async (_toolCallId, args) => {
      const params = (args ?? {}) as Record<string, unknown>;
      const action =
        typeof params.action === "string" && params.action.trim()
          ? params.action.trim()
          : "list_channels";

      const t0 = Date.now();
      console.log(`[slack-tool] action=${action} params=${JSON.stringify(params)}`);
      try {
        const result = await executeSlackAction(action, params, client);
        console.log(`[slack-tool] action=${action} done in ${Date.now() - t0}ms`);
        return result;
      } catch (err) {
        console.log(`[slack-tool] action=${action} error after ${Date.now() - t0}ms: ${err}`);
        throw err;
      }
    },
  };
}

async function executeSlackAction(
  action: string,
  params: Record<string, unknown>,
  client: NonNullable<ReturnType<typeof createSlackClient>>,
): Promise<AgentToolResult<unknown>> {
  switch (action) {
    case "post_message": {
      const text = readStringParam(params, "text", { required: true });
      const channel = readStringParam(params, "channel");
      const threadTs = readStringParam(params, "threadTs");
      const result = await client.postMessage({
        channel: channel ?? "",
        text,
        threadTs,
      });
      return {
        content: [{ type: "text", text: `Message posted to ${result.channel}` }],
        details: result,
      };
    }

    case "channel_history": {
      const channel = readStringParam(params, "channel", { required: true });
      const limit = readNumberParam(params, "limit", { integer: true }) ?? 20;
      const messages = await client.getChannelHistory(channel, Math.max(1, Math.min(100, limit)));
      const text =
        messages.length > 0
          ? messages.map((m) => `[${m.ts}] ${m.user ?? "unknown"}: ${m.text}`).join("\n")
          : "No messages found.";
      return {
        content: [{ type: "text", text }],
        details: { channel, count: messages.length, messages },
      };
    }

    case "thread_replies": {
      const channel = readStringParam(params, "channel", { required: true });
      const threadTs = readStringParam(params, "threadTs", { required: true });
      const messages = await client.getThreadReplies(channel, threadTs);
      const text =
        messages.length > 0
          ? messages.map((m) => `[${m.ts}] ${m.user ?? "unknown"}: ${m.text}`).join("\n")
          : "No replies found.";
      return {
        content: [{ type: "text", text }],
        details: { channel, threadTs, count: messages.length, messages },
      };
    }

    case "read_dm": {
      const query = readStringParam(params, "query", { required: true });
      const limit = readNumberParam(params, "limit", { integer: true }) ?? 10;
      // All-in-one: find user → open DM → read history.
      const users = await client.findUsers(query, 1);
      if (users.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No user found matching "${query}". Try a more specific username or name.`,
            },
          ],
          details: { query, found: false },
        };
      }
      const user = users[0];
      const dm = await client.openDM(user.id);
      const messages = await client.getChannelHistory(
        dm.channelId,
        Math.max(1, Math.min(50, limit)),
      );
      const header = `DM with ${user.realName ?? user.name} (${user.name}, ${user.id}), channel ${dm.channelId}`;
      const body =
        messages.length > 0
          ? messages.map((m) => `[${m.ts}] ${m.user ?? "unknown"}: ${m.text}`).join("\n")
          : "No messages in this conversation.";
      return {
        content: [{ type: "text", text: `${header}\n${messages.length} message(s):\n${body}` }],
        details: {
          user,
          channelId: dm.channelId,
          count: messages.length,
          messages,
        },
      };
    }

    case "list_dms": {
      const query = readStringParam(params, "query");
      const limit = readNumberParam(params, "limit", { integer: true }) ?? (query ? 10 : 20);

      // If query is provided, use fast search to find that specific person's DM.
      if (query) {
        const users = await client.findUsers(query, 1);
        if (users.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No user found matching "${query}". Try a more specific username.`,
              },
            ],
            details: { query, found: false },
          };
        }
        const user = users[0];
        const dm = await client.openDM(user.id);
        const messages = await client.getChannelHistory(
          dm.channelId,
          Math.max(1, Math.min(50, limit)),
        );
        const header = `DM with ${user.realName ?? user.name} (@${user.name}), channel ${dm.channelId}`;
        const body =
          messages.length > 0
            ? messages.map((m) => `[${m.ts}] ${m.user ?? "unknown"}: ${m.text}`).join("\n")
            : "No messages in this conversation.";
        return {
          content: [{ type: "text", text: `${header}\n${messages.length} message(s):\n${body}` }],
          details: {
            user,
            channelId: dm.channelId,
            count: messages.length,
            messages,
          },
        };
      }

      // No query — list recent DMs.
      const dms = await client.listDMs(Math.max(1, Math.min(50, limit)));
      if (dms.length === 0) {
        return {
          content: [{ type: "text", text: "No DM conversations found." }],
          details: { count: 0 },
        };
      }
      const lines: string[] = [];
      for (const dm of dms) {
        const name = dm.realName ?? dm.userName ?? dm.user;
        const preview = dm.latest?.text ? ` | ${dm.latest.text.slice(0, 100)}` : "";
        lines.push(`${dm.id} — ${name} (${dm.userName ?? dm.user})${preview}`);
      }
      const hint =
        "\nTip: To find a specific person's DMs, use list_dms with query=their_username.";
      return {
        content: [
          { type: "text", text: `${dms.length} DM conversation(s):\n${lines.join("\n")}${hint}` },
        ],
        details: { count: dms.length, dms },
      };
    }

    case "find_user": {
      const query = readStringParam(params, "query", { required: true });
      const limit = readNumberParam(params, "limit", { integer: true }) ?? 10;
      const users = await client.findUsers(query, Math.max(1, Math.min(25, limit)));
      if (users.length === 0) {
        return {
          content: [{ type: "text", text: `No users found matching "${query}".` }],
          details: { count: 0 },
        };
      }
      const text = users
        .map(
          (u) => `${u.id} — ${u.realName ?? u.name} (${u.name})${u.email ? ` <${u.email}>` : ""}`,
        )
        .join("\n");
      return {
        content: [{ type: "text", text: `${users.length} user(s) found:\n${text}` }],
        details: { count: users.length, users },
      };
    }

    case "open_dm": {
      const userId = readStringParam(params, "userId", { required: true });
      const result = await client.openDM(userId);
      return {
        content: [
          {
            type: "text",
            text: `DM channel opened: ${result.channelId} (use channel_history to read messages)`,
          },
        ],
        details: result,
      };
    }

    case "search_messages": {
      const query = readStringParam(params, "query", { required: true });
      const limit = readNumberParam(params, "limit", { integer: true });
      const result = await client.searchMessages({
        query,
        count: limit ? Math.max(1, Math.min(100, limit)) : undefined,
      });
      const text =
        result.messages.length > 0
          ? result.messages
              .map((m) => `[${m.channel}] ${m.user ?? "unknown"}: ${m.text}`)
              .join("\n")
          : "No messages found.";
      return {
        content: [{ type: "text", text: `${result.total} result(s)\n${text}` }],
        details: result,
      };
    }

    case "list_channels": {
      const limit = readNumberParam(params, "limit", { integer: true }) ?? 100;
      const channels = await client.listChannels(Math.max(1, Math.min(1000, limit)));
      const text =
        channels.length > 0
          ? channels
              .map(
                (c) =>
                  `${c.name} (${c.id})${c.isPrivate ? " [private]" : ""}${c.topic ? ` - ${c.topic}` : ""}`,
              )
              .join("\n")
          : "No channels found.";
      return {
        content: [{ type: "text", text }],
        details: { count: channels.length, channels },
      };
    }

    case "lookup_user": {
      const userId = readStringParam(params, "userId", { required: true });
      const user = await client.lookupUser(userId);
      const text = [
        `${user.name} (${user.id})`,
        user.realName ? `Name: ${user.realName}` : null,
        user.email ? `Email: ${user.email}` : null,
        user.isBot ? "Bot: yes" : null,
      ]
        .filter(Boolean)
        .join("\n");
      return {
        content: [{ type: "text", text }],
        details: user,
      };
    }

    case "add_reaction": {
      const channel = readStringParam(params, "channel", { required: true });
      const timestamp = readStringParam(params, "timestamp", { required: true });
      const emoji = readStringParam(params, "emoji", { required: true });
      await client.addReaction(channel, timestamp, emoji.replace(/^:|:$/g, ""));
      return {
        content: [{ type: "text", text: `Reaction :${emoji}: added` }],
        details: { channel, timestamp, emoji },
      };
    }

    case "set_topic": {
      const channel = readStringParam(params, "channel", { required: true });
      const topic = readStringParam(params, "topic", { required: true });
      await client.setChannelTopic(channel, topic);
      return {
        content: [{ type: "text", text: `Topic set on ${channel}` }],
        details: { channel, topic },
      };
    }

    default:
      throw new Error(`Unknown slack_integration action: ${action}`);
  }
}
