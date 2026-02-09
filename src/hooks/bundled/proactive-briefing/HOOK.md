---
name: proactive-briefing
description: "Inject recent session context into HEARTBEAT.md on gateway startup"
homepage: https://docs.openclaw.ai/hooks#proactive-briefing
metadata:
  {
    "openclaw":
      {
        "emoji": "🌅",
        "events": ["gateway:startup"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Proactive Briefing Hook

Automatically injects recent session context into your HEARTBEAT.md file when the gateway starts. This enables the existing heartbeat system to deliver proactive, context-aware briefings.

## What It Does

On gateway startup:

1. **Reads recent session logs** from `memory/sessions/` (created by the session-autosave hook)
2. **Extracts key context** — recent topics, user questions, and assistant responses
3. **Appends a Daily Context section** to HEARTBEAT.md with a summary of recent activity
4. The existing heartbeat system then naturally includes this context in its periodic runs

## How It Works With Heartbeats

The heartbeat system already reads HEARTBEAT.md and acts on its contents. By injecting recent session context, the heartbeat becomes a proactive intelligence system that can:

- Remind you about topics from yesterday's sessions
- Follow up on unanswered questions
- Provide morning briefings based on recent activity

## Output Format

The hook appends a managed section to HEARTBEAT.md:

```markdown
<!-- proactive-briefing:start -->
## Daily Context (auto-generated)

Recent session activity (last 24h):
- Discussed API design for the new auth module
- Debugged gateway startup issue with TLS certificates
- Reviewed PR #42 for the routing refactor
<!-- proactive-briefing:end -->
```

## Configuration

| Option       | Type    | Default | Description                                    |
| ------------ | ------- | ------- | ---------------------------------------------- |
| `enabled`    | boolean | true    | Enable/disable proactive briefing              |
| `maxLines`   | number  | 20      | Max lines of context to inject                 |
| `lookbackMs` | number  | 86400000 | How far back to look for sessions (default 24h) |

## Disabling

```bash
openclaw hooks disable proactive-briefing
```
