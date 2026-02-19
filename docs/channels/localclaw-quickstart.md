---
summary: "Quick reference for setting up messaging channels with LocalClaw"
read_when:
  - You want to connect a messaging channel to LocalClaw
  - You need LocalClaw-specific channel setup instructions
title: "LocalClaw Channel Quickstart"
---

# LocalClaw Channel Quickstart

LocalClaw includes the full OpenClaw multi-channel messaging stack. This guide covers the LocalClaw-specific commands and paths. For detailed per-channel documentation, see the [OpenClaw channel docs](https://docs.openclaw.ai/channels) — everything applies, just substitute `localclaw` for `openclaw`.

## Key Differences from OpenClaw

| | OpenClaw | LocalClaw |
|---|---|---|
| **Binary** | `openclaw` | `localclaw` |
| **Config file** | `~/.openclaw/openclaw.json` | `~/.localclaw/openclaw.local.json` |
| **Gateway port** | 18789 | 18790 |
| **State directory** | `~/.openclaw/` | `~/.localclaw/` |
| **Session data** | `~/.openclaw/sessions/` | `~/.localclaw/sessions/` |

## Channel Setup During Onboarding

The easiest way to add a channel is during first-run onboarding:

```bash
localclaw onboard
```

The wizard walks you through:
1. Model selection (local model server detection)
2. Gateway configuration
3. **Channel selection** — pick one or more channels, enter tokens/credentials
4. Security defaults (DM pairing, allowlists)

## Adding Channels After Setup

### Interactive

```bash
# Add a channel interactively
localclaw channels add --channel telegram
localclaw channels add --channel whatsapp
localclaw channels add --channel discord

# Reconfigure channels via the configure wizard
localclaw configure --section channels
```

### Direct (Non-Interactive)

```bash
# Telegram — paste your @BotFather token
localclaw channels add --channel telegram --token "123456:ABC-DEF..."

# Discord — paste your bot token
localclaw channels add --channel discord --bot-token "MTIzNDU2..."

# Signal — link a device
localclaw channels add --channel signal --signal-number "+15555550123"
```

## Channel Management Commands

```bash
# List all channels and their status
localclaw channels status

# Check a specific channel
localclaw channels status --channel telegram

# Remove a channel
localclaw channels remove --channel telegram

# View channel logs
localclaw channels logs --channel whatsapp
```

## Security: DM Pairing

By default, LocalClaw uses **DM pairing** — unknown senders receive a short code and the bot ignores their message until you approve them:

```bash
# Approve a sender
localclaw pairing approve telegram ABC123

# List pending pairing requests
localclaw pairing list

# List approved senders
localclaw pairing list --approved
```

To open DMs to everyone (not recommended for public-facing bots):

```json5
{
  channels: {
    telegram: {
      botToken: "...",
      dmPolicy: "open",
      allowFrom: ["*"],
    },
  },
}
```

Run `localclaw doctor` to check for risky DM configurations.

## Easiest Channels to Set Up

### Telegram (Recommended for Quick Start)

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot`, follow the prompts, copy the token
3. Run: `localclaw channels add --channel telegram --token "YOUR_TOKEN"`
4. Restart the gateway: `localclaw gateway`
5. Message your bot on Telegram

### WhatsApp

1. Run: `localclaw channels add --channel whatsapp`
2. Scan the QR code with WhatsApp on your phone (Settings > Linked Devices)
3. Restart the gateway

### Discord

1. Create a bot at [discord.com/developers/applications](https://discord.com/developers/applications)
2. Copy the bot token from the Bot page
3. Run: `localclaw channels add --channel discord --bot-token "YOUR_TOKEN"`
4. Invite the bot to your server using the OAuth2 URL generator
5. Restart the gateway

## Configuration Reference

All channel config lives in `~/.localclaw/openclaw.local.json` under the `channels` key:

```json5
{
  channels: {
    telegram: {
      botToken: "123456:ABC-DEF...",
      allowFrom: ["+15555550123"],
    },
    whatsapp: {
      allowFrom: ["+15555550123"],
    },
    discord: {
      botToken: "MTIzNDU2...",
      allowFrom: ["username#1234"],
    },
    slack: {
      appToken: "xapp-1-...",
      botToken: "xoxb-...",
    },
  },
}
```

## Running Multiple Channels

LocalClaw can run all channels simultaneously. Configure as many as you need — the gateway starts a monitor for each enabled channel and routes messages to the right agent session.

```bash
# Verify all channels are connected
localclaw channels status

# Send a message to a specific channel
localclaw message send --to "+15555550123" --channel whatsapp --message "Hello"
```

## Troubleshooting

- **Channel not connecting** — Check `localclaw channels status` and `localclaw channels logs --channel <name>`
- **Bot not responding** — Verify the gateway is running: `localclaw gateway status`
- **"Pairing required" responses** — Approve the sender: `localclaw pairing approve <channel> <code>`
- **Config validation errors** — Run `localclaw doctor` for diagnostics
- **WhatsApp QR expired** — Run `localclaw channels add --channel whatsapp` to re-pair

For detailed per-channel troubleshooting, see the [OpenClaw channel docs](https://docs.openclaw.ai/channels).
