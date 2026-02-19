import { describe, expect, it } from "vitest";
import { type OpenClawConfig, DEFAULT_GATEWAY_PORT } from "../config/config.js";
import {
  buildDefaultHookUrl,
  buildTopicPath,
  parseTopicPath,
  resolveGmailHookRuntimeConfig,
  resolveGmailMultiAccountConfigs,
} from "./gmail.js";

const baseConfig = {
  hooks: {
    token: "hook-token",
    gmail: {
      account: "openclaw@gmail.com",
      topic: "projects/demo/topics/gog-gmail-watch",
      pushToken: "push-token",
    },
  },
} satisfies OpenClawConfig;

describe("gmail hook config", () => {
  it("builds default hook url", () => {
    expect(buildDefaultHookUrl("/hooks", DEFAULT_GATEWAY_PORT)).toBe(
      `http://127.0.0.1:${DEFAULT_GATEWAY_PORT}/hooks/gmail`,
    );
  });

  it("parses topic path", () => {
    const topic = buildTopicPath("proj", "topic");
    expect(parseTopicPath(topic)).toEqual({
      projectId: "proj",
      topicName: "topic",
    });
  });

  it("resolves runtime config with defaults", () => {
    const result = resolveGmailHookRuntimeConfig(baseConfig, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.account).toBe("openclaw@gmail.com");
      expect(result.value.label).toBe("INBOX");
      expect(result.value.includeBody).toBe(true);
      expect(result.value.serve.port).toBe(8788);
      expect(result.value.hookUrl).toBe(`http://127.0.0.1:${DEFAULT_GATEWAY_PORT}/hooks/gmail`);
    }
  });

  it("fails without hook token", () => {
    const result = resolveGmailHookRuntimeConfig(
      {
        hooks: {
          gmail: {
            account: "openclaw@gmail.com",
            topic: "projects/demo/topics/gog-gmail-watch",
            pushToken: "push-token",
          },
        },
      },
      {},
    );
    expect(result.ok).toBe(false);
  });

  it("defaults serve path to / when tailscale is enabled", () => {
    const result = resolveGmailHookRuntimeConfig(
      {
        hooks: {
          token: "hook-token",
          gmail: {
            account: "openclaw@gmail.com",
            topic: "projects/demo/topics/gog-gmail-watch",
            pushToken: "push-token",
            tailscale: { mode: "funnel" },
          },
        },
      },
      {},
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.serve.path).toBe("/");
      expect(result.value.tailscale.path).toBe("/gmail-pubsub");
    }
  });

  it("keeps the default public path when serve path is explicit", () => {
    const result = resolveGmailHookRuntimeConfig(
      {
        hooks: {
          token: "hook-token",
          gmail: {
            account: "openclaw@gmail.com",
            topic: "projects/demo/topics/gog-gmail-watch",
            pushToken: "push-token",
            serve: { path: "/gmail-pubsub" },
            tailscale: { mode: "funnel" },
          },
        },
      },
      {},
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.serve.path).toBe("/");
      expect(result.value.tailscale.path).toBe("/gmail-pubsub");
    }
  });

  it("keeps custom public path when serve path is set", () => {
    const result = resolveGmailHookRuntimeConfig(
      {
        hooks: {
          token: "hook-token",
          gmail: {
            account: "openclaw@gmail.com",
            topic: "projects/demo/topics/gog-gmail-watch",
            pushToken: "push-token",
            serve: { path: "/custom" },
            tailscale: { mode: "funnel" },
          },
        },
      },
      {},
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.serve.path).toBe("/");
      expect(result.value.tailscale.path).toBe("/custom");
    }
  });

  it("keeps serve path when tailscale target is set", () => {
    const result = resolveGmailHookRuntimeConfig(
      {
        hooks: {
          token: "hook-token",
          gmail: {
            account: "openclaw@gmail.com",
            topic: "projects/demo/topics/gog-gmail-watch",
            pushToken: "push-token",
            serve: { path: "/custom" },
            tailscale: {
              mode: "funnel",
              target: "http://127.0.0.1:8788/custom",
            },
          },
        },
      },
      {},
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.serve.path).toBe("/custom");
      expect(result.value.tailscale.path).toBe("/custom");
      expect(result.value.tailscale.target).toBe("http://127.0.0.1:8788/custom");
    }
  });
});

describe("resolveGmailMultiAccountConfigs", () => {
  it("resolves multiple accounts with auto-incremented ports", () => {
    const cfg: OpenClawConfig = {
      hooks: {
        token: "hook-token",
        gmail: {
          topic: "projects/demo/topics/gog-gmail-watch",
          pushToken: "push-token",
          accounts: [{ address: "home@gmail.com" }, { address: "work@company.com" }],
        },
      },
    };
    const result = resolveGmailMultiAccountConfigs(cfg, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(2);
      expect(result.value[0].account).toBe("home@gmail.com");
      expect(result.value[0].serve.port).toBe(8788);
      expect(result.value[1].account).toBe("work@company.com");
      expect(result.value[1].serve.port).toBe(8789);
    }
  });

  it("applies per-account overrides", () => {
    const cfg: OpenClawConfig = {
      hooks: {
        token: "hook-token",
        gmail: {
          topic: "projects/demo/topics/default-topic",
          pushToken: "push-token",
          accounts: [
            {
              address: "home@gmail.com",
              label: "personal",
              topic: "projects/demo/topics/home-topic",
              port: 9000,
            },
            { address: "work@company.com" },
          ],
        },
      },
    };
    const result = resolveGmailMultiAccountConfigs(cfg, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value[0].account).toBe("home@gmail.com");
      expect(result.value[0].label).toBe("personal");
      expect(result.value[0].topic).toBe("projects/demo/topics/home-topic");
      expect(result.value[0].serve.port).toBe(9000);
      expect(result.value[1].account).toBe("work@company.com");
      expect(result.value[1].topic).toBe("projects/demo/topics/default-topic");
      expect(result.value[1].serve.port).toBe(8789);
    }
  });

  it("falls back to legacy single-account config", () => {
    const result = resolveGmailMultiAccountConfigs(baseConfig, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0].account).toBe("openclaw@gmail.com");
      expect(result.value[0].serve.port).toBe(8788);
    }
  });

  it("fails if a per-account config is invalid", () => {
    const cfg: OpenClawConfig = {
      hooks: {
        // Missing hook token
        gmail: {
          topic: "projects/demo/topics/gog-gmail-watch",
          pushToken: "push-token",
          accounts: [{ address: "home@gmail.com" }],
        },
      },
    };
    const result = resolveGmailMultiAccountConfigs(cfg, {});
    expect(result.ok).toBe(false);
  });
});
