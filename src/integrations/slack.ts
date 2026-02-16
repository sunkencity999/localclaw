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
    // Use userToken for DM channels (IDs start with D) so the message is sent as the user.
    const token = channel.startsWith("D") && this.userToken ? this.userToken : undefined;
    const result = await this.request<{
      message: { ts: string; text: string; user?: string };
      channel: string;
    }>(
      "chat.postMessage",
      {
        channel,
        text: params.text,
        ...(params.threadTs ? { thread_ts: params.threadTs } : {}),
        ...(params.unfurlLinks !== undefined ? { unfurl_links: params.unfurlLinks } : {}),
      },
      { token: token ?? undefined },
    );
    return {
      ts: result.message.ts,
      channel: result.channel,
      text: result.message.text,
      user: result.message.user ?? null,
    };
  }

  async joinChannel(channel: string): Promise<void> {
    await this.request("conversations.join", { channel });
  }

  async getChannelHistory(channel: string, limit = 20): Promise<SlackMessage[]> {
    // Use userToken for DM channels (IDs start with D) so we can read the user's DMs.
    const token = channel.startsWith("D") && this.userToken ? this.userToken : undefined;
    const opts = token ? { token } : undefined;
    try {
      return await this.fetchHistory(channel, limit, opts);
    } catch (err) {
      if (err instanceof Error && err.message.includes("not_in_channel")) {
        await this.joinChannel(channel);
        return this.fetchHistory(channel, limit, opts);
      }
      throw err;
    }
  }

  private async fetchHistory(
    channel: string,
    limit: number,
    opts?: { token?: string },
  ): Promise<SlackMessage[]> {
    const result = await this.request<{
      messages: Array<{
        ts: string;
        text: string;
        user?: string;
        thread_ts?: string;
      }>;
    }>("conversations.history", { channel, limit }, opts);

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
    const opts = token ? { token } : undefined;
    try {
      return await this.fetchReplies(channel, threadTs, opts);
    } catch (err) {
      if (err instanceof Error && err.message.includes("not_in_channel")) {
        await this.joinChannel(channel);
        return this.fetchReplies(channel, threadTs, opts);
      }
      throw err;
    }
  }

  private async fetchReplies(
    channel: string,
    threadTs: string,
    opts?: { token?: string },
  ): Promise<SlackMessage[]> {
    const result = await this.request<{
      messages: Array<{
        ts: string;
        text: string;
        user?: string;
        thread_ts?: string;
      }>;
    }>("conversations.replies", { channel, ts: threadTs }, opts);

    return result.messages.map((msg) => ({
      ts: msg.ts,
      channel,
      text: msg.text,
      user: msg.user ?? null,
      threadTs: msg.thread_ts ?? null,
    }));
  }

  private userNameCache: Map<string, string> = new Map();

  async resolveUserNames(userIds: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(userIds.filter(Boolean))];
    const missing = unique.filter((id) => !this.userNameCache.has(id));
    await Promise.all(
      missing.map(async (id) => {
        try {
          const user = await this.lookupUser(id);
          this.userNameCache.set(id, user.realName ?? user.name);
        } catch {
          this.userNameCache.set(id, id);
        }
      }),
    );
    return this.userNameCache;
  }

  private channelNameCache: Map<string, string> | null = null;

  async resolveChannelId(channelOrName: string): Promise<string> {
    const trimmed = channelOrName.trim();
    if (/^[CGD][A-Z0-9]+$/i.test(trimmed)) {
      return trimmed;
    }
    const name = trimmed.replace(/^#/, "").toLowerCase();
    if (!name) {
      return trimmed;
    }
    if (this.channelNameCache) {
      const cached = this.channelNameCache.get(name);
      if (cached) {
        return cached;
      }
    }
    const channels = await this.listChannels(1000);
    this.channelNameCache = new Map();
    for (const ch of channels) {
      this.channelNameCache.set(ch.name.toLowerCase(), ch.id);
    }
    const resolved = this.channelNameCache.get(name);
    if (resolved) {
      return resolved;
    }
    return trimmed;
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

  async listDMs(limit = 20): Promise<
    Array<{
      id: string;
      user: string;
      userName?: string | null;
      realName?: string | null;
      latest?: SlackMessage | null;
    }>
  > {
    // Use userToken to list the user's DMs (bot token only sees its own DMs).
    const token = this.userToken ?? this.botToken;
    // Fetch more channels than requested so we can sort by activity and return the top N.
    const fetchLimit = Math.min(limit * 2, 200);
    const result = await this.request<{
      channels: Array<{
        id: string;
        user: string;
      }>;
    }>("conversations.list", { types: "im", limit: fetchLimit, exclude_archived: true }, { token });

    const channels = result.channels;
    if (channels.length === 0) return [];

    // In parallel: resolve user names AND fetch latest message for each DM.
    // conversations.list doesn't return 'latest' for IM channels, so we
    // fetch it via conversations.history with limit=1.
    const userIds = channels.map((dm) => dm.user).filter(Boolean);
    const nameMap = new Map<string, { name: string; realName: string | null }>();
    const latestMap = new Map<string, SlackMessage | null>();

    const allWork = await Promise.allSettled([
      // Batch 1: user info lookups.
      ...userIds.map((uid) =>
        this.request<{
          user: { id: string; name: string; real_name?: string };
        }>("users.info", { user: uid }).then((r) => ({
          _type: "user" as const,
          id: uid,
          name: r.user.name,
          realName: r.user.real_name ?? null,
        })),
      ),
      // Batch 2: latest message for each DM.
      ...channels.map((dm) =>
        this.request<{
          messages: Array<{ ts: string; text: string; user?: string; thread_ts?: string }>;
        }>("conversations.history", { channel: dm.id, limit: 1 }, { token }).then((r) => ({
          _type: "history" as const,
          channelId: dm.id,
          message: r.messages?.[0] ?? null,
        })),
      ),
    ]);

    for (const r of allWork) {
      if (r.status !== "fulfilled") continue;
      const val = r.value;
      if (val._type === "user") {
        nameMap.set(val.id, { name: val.name, realName: val.realName });
      } else if (val._type === "history") {
        const msg = val.message;
        latestMap.set(
          val.channelId,
          msg
            ? {
                ts: msg.ts,
                channel: val.channelId,
                text: msg.text,
                user: msg.user ?? null,
                threadTs: msg.thread_ts ?? null,
              }
            : null,
        );
      }
    }

    // Build results and sort by most recent message first.
    const results = channels.map((dm) => {
      const info = nameMap.get(dm.user);
      return {
        id: dm.id,
        user: dm.user,
        userName: info?.name ?? null,
        realName: info?.realName ?? null,
        latest: latestMap.get(dm.id) ?? null,
      };
    });

    // Sort: DMs with messages first (newest message first), then empty DMs last.
    results.sort((a, b) => {
      const tsA = a.latest ? Number(a.latest.ts) : 0;
      const tsB = b.latest ? Number(b.latest.ts) : 0;
      return tsB - tsA;
    });

    return results.slice(0, limit);
  }

  /**
   * Search for users by name, username, or email.
   * Primary strategy: use search.messages from:<query> (fast, works for large workspaces).
   * Fallback: paginated users.list (slower, for users who never posted).
   */
  async findUsers(query: string, limit = 10): Promise<SlackUser[]> {
    // Fast path: search.messages from:<query> returns user IDs instantly.
    if (this.userToken) {
      try {
        const searchResult = await this.request<{
          messages: {
            matches: Array<{ user?: string; username?: string }>;
          };
        }>("search.messages", { query: `from:${query}`, count: 20 }, { token: this.userToken });
        // Collect unique user IDs from search results.
        const seen = new Set<string>();
        const userIds: string[] = [];
        for (const m of searchResult.messages.matches) {
          const uid = m.user;
          if (uid && !seen.has(uid)) {
            seen.add(uid);
            userIds.push(uid);
            if (userIds.length >= limit) break;
          }
        }
        if (userIds.length > 0) {
          // Resolve user IDs to full profiles in parallel.
          const results = await Promise.allSettled(
            userIds.map((uid) =>
              this.request<{
                user: {
                  id: string;
                  name: string;
                  real_name?: string;
                  profile?: { email?: string };
                  is_bot: boolean;
                };
              }>("users.info", { user: uid }).then((r) => ({
                id: r.user.id,
                name: r.user.name,
                realName: r.user.real_name ?? null,
                email: r.user.profile?.email ?? null,
                isBot: r.user.is_bot,
              })),
            ),
          );
          const users: SlackUser[] = [];
          for (const r of results) {
            if (r.status === "fulfilled") users.push(r.value);
          }
          if (users.length > 0) return users;
        }
      } catch {
        // Fall through to users.list pagination.
      }
    }

    // Fallback: paginate users.list (cap at 3 pages / 600 users).
    const q = query.toLowerCase();
    const matches: SlackUser[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 3 && matches.length < limit; page++) {
      const params: Record<string, unknown> = { limit: 200 };
      if (cursor) params.cursor = cursor;
      const result = await this.request<{
        members: Array<{
          id: string;
          name: string;
          real_name?: string;
          profile?: { email?: string; display_name?: string };
          is_bot: boolean;
          deleted: boolean;
        }>;
        response_metadata?: { next_cursor?: string };
      }>("users.list", params);

      for (const u of result.members) {
        if (u.deleted) continue;
        const fields = [u.name, u.real_name, u.profile?.email, u.profile?.display_name]
          .filter(Boolean)
          .map((s) => s!.toLowerCase());
        if (fields.some((f) => f.includes(q))) {
          matches.push({
            id: u.id,
            name: u.name,
            realName: u.real_name ?? null,
            email: u.profile?.email ?? null,
            isBot: u.is_bot,
          });
          if (matches.length >= limit) break;
        }
      }

      cursor = result.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
    return matches;
  }

  /** Open (or find) a DM channel with a specific user. */
  async openDM(userId: string): Promise<{ channelId: string }> {
    const token = this.userToken ?? this.botToken;
    const result = await this.request<{
      channel: { id: string };
    }>("conversations.open", { users: userId }, { token });
    return { channelId: result.channel.id };
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
