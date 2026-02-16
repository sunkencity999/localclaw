import type { z } from "zod";
import type { SlackIntegrationSchema } from "../config/zod-schema.integrations.js";

export type SlackConfig = z.infer<typeof SlackIntegrationSchema>;

export type SlackMessage = {
  ts: string;
  channel: string;
  text: string;
  user?: string | null;
  threadTs?: string | null;
};

export type SlackChannel = {
  id: string;
  name: string;
  isPrivate: boolean;
  isMember: boolean;
  topic?: string | null;
  purpose?: string | null;
};

export type SlackUser = {
  id: string;
  name: string;
  realName?: string | null;
  email?: string | null;
  isBot: boolean;
};

export type SlackPostMessageParams = {
  channel: string;
  text: string;
  threadTs?: string;
  unfurlLinks?: boolean;
};

export type SlackSearchParams = {
  query: string;
  count?: number;
  sort?: "score" | "timestamp";
};

export class SlackClient {
  private botToken: string;
  private userToken: string | undefined;
  private defaultChannel: string | undefined;
  private timeoutMs: number;

  constructor(config: NonNullable<SlackConfig>) {
    if (!config.botToken) {
      throw new Error("Slack botToken is required");
    }
    this.botToken = config.botToken;
    this.userToken = config.userToken;
    this.defaultChannel = config.defaultChannel;
    this.timeoutMs = (config.timeoutSeconds ?? 30) * 1000;
  }

  private authHeaderFor(token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}` };
  }

  /**
   * Make a Slack Web API call using application/x-www-form-urlencoded.
   * Slack's API ignores JSON body params for many read methods, so
   * form-urlencoded is the safest universal format.
   */
  private async request<T>(
    method: string,
    body?: Record<string, unknown>,
    opts?: { token?: string },
  ): Promise<T> {
    const token = opts?.token ?? this.botToken;
    const url = `https://slack.com/api/${method}`;
    let fetchBody: string | undefined;
    const headers: Record<string, string> = {
      ...this.authHeaderFor(token),
      "Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
    };
    if (body) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(body)) {
        if (v === undefined || v === null) continue;
        params.set(k, typeof v === "string" ? v : JSON.stringify(v));
      }
      fetchBody = params.toString();
    }
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: fetchBody,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Slack HTTP error ${response.status}`);
    }
    const result = (await response.json()) as { ok: boolean; error?: string } & T;
    if (!result.ok) {
      throw new Error(`Slack API error: ${result.error ?? "unknown"}`);
    }
    return result;
  }

  async postMessage(params: SlackPostMessageParams): Promise<SlackMessage> {
    const channel = params.channel || this.defaultChannel;
    if (!channel) {
      throw new Error("Channel is required (set defaultChannel in config or pass explicitly)");
    }
    const result = await this.request<{
      message: { ts: string; text: string; user?: string };
      channel: string;
    }>("chat.postMessage", {
      channel,
      text: params.text,
      ...(params.threadTs ? { thread_ts: params.threadTs } : {}),
      ...(params.unfurlLinks !== undefined ? { unfurl_links: params.unfurlLinks } : {}),
    });
    return {
      ts: result.message.ts,
      channel: result.channel,
      text: result.message.text,
      user: result.message.user ?? null,
    };
  }

  async getChannelHistory(channel: string, limit = 20): Promise<SlackMessage[]> {
    // Use userToken for DM channels (IDs start with D) so we can read the user's DMs.
    const token = channel.startsWith("D") && this.userToken ? this.userToken : undefined;
    const result = await this.request<{
      messages: Array<{
        ts: string;
        text: string;
        user?: string;
        thread_ts?: string;
      }>;
    }>("conversations.history", { channel, limit }, token ? { token } : undefined);

    return result.messages.map((msg) => ({
      ts: msg.ts,
      channel,
      text: msg.text,
      user: msg.user ?? null,
      threadTs: msg.thread_ts ?? null,
    }));
  }

  async getThreadReplies(channel: string, threadTs: string): Promise<SlackMessage[]> {
    const token = channel.startsWith("D") && this.userToken ? this.userToken : undefined;
    const result = await this.request<{
      messages: Array<{
        ts: string;
        text: string;
        user?: string;
        thread_ts?: string;
      }>;
    }>("conversations.replies", { channel, ts: threadTs }, token ? { token } : undefined);

    return result.messages.map((msg) => ({
      ts: msg.ts,
      channel,
      text: msg.text,
      user: msg.user ?? null,
      threadTs: msg.thread_ts ?? null,
    }));
  }

  async listChannels(limit = 100): Promise<SlackChannel[]> {
    const result = await this.request<{
      channels: Array<{
        id: string;
        name: string;
        is_private: boolean;
        is_member: boolean;
        topic?: { value: string };
        purpose?: { value: string };
      }>;
    }>("conversations.list", {
      types: "public_channel,private_channel",
      limit,
      exclude_archived: true,
    });

    return result.channels.map((ch) => ({
      id: ch.id,
      name: ch.name,
      isPrivate: ch.is_private,
      isMember: ch.is_member,
      topic: ch.topic?.value || null,
      purpose: ch.purpose?.value || null,
    }));
  }

  async lookupUser(userId: string): Promise<SlackUser> {
    const result = await this.request<{
      user: {
        id: string;
        name: string;
        real_name?: string;
        profile?: { email?: string };
        is_bot: boolean;
      };
    }>("users.info", { user: userId });

    return {
      id: result.user.id,
      name: result.user.name,
      realName: result.user.real_name ?? null,
      email: result.user.profile?.email ?? null,
      isBot: result.user.is_bot,
    };
  }

  async listDMs(
    limit = 20,
  ): Promise<Array<{ id: string; user: string; latest?: SlackMessage | null }>> {
    // Use userToken to list the user's DMs (bot token only sees its own DMs).
    const token = this.userToken ?? this.botToken;
    const result = await this.request<{
      channels: Array<{
        id: string;
        user: string;
        latest?: { ts: string; text: string; user?: string; thread_ts?: string } | null;
      }>;
    }>("conversations.list", { types: "im", limit, exclude_archived: true }, { token });

    return result.channels.map((dm) => ({
      id: dm.id,
      user: dm.user,
      latest: dm.latest
        ? {
            ts: dm.latest.ts,
            channel: dm.id,
            text: dm.latest.text,
            user: dm.latest.user ?? null,
            threadTs: dm.latest.thread_ts ?? null,
          }
        : null,
    }));
  }

  async searchMessages(params: SlackSearchParams): Promise<{
    messages: SlackMessage[];
    total: number;
  }> {
    // search.messages requires a user token (xoxp-), not a bot token (xoxb-).
    if (!this.userToken) {
      throw new Error(
        "Slack search requires a User OAuth Token (xoxp-...). " +
          "Bot tokens cannot use search.messages. " +
          "Add a 'userToken' to your Slack integration config, or use 'list_channels' + 'channel_history' instead.",
      );
    }
    const result = await this.request<{
      messages: {
        total: number;
        matches: Array<{
          ts: string;
          text: string;
          user?: string;
          channel: { id: string; name: string };
        }>;
      };
    }>(
      "search.messages",
      {
        query: params.query,
        count: params.count ?? 20,
        sort: params.sort ?? "score",
      },
      { token: this.userToken },
    );

    return {
      messages: result.messages.matches.map((m) => ({
        ts: m.ts,
        channel: m.channel.id,
        text: m.text,
        user: m.user ?? null,
      })),
      total: result.messages.total,
    };
  }

  async addReaction(channel: string, timestamp: string, emoji: string): Promise<void> {
    await this.request("reactions.add", {
      channel,
      timestamp,
      name: emoji,
    });
  }

  async setChannelTopic(channel: string, topic: string): Promise<void> {
    await this.request("conversations.setTopic", { channel, topic });
  }
}

export function createSlackClient(config: SlackConfig): SlackClient | null {
  if (!config?.enabled) {
    return null;
  }
  return new SlackClient(config);
}
