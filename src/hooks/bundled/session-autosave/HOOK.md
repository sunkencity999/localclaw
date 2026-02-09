---
name: session-autosave
description: "Auto-save session context after each agent turn"
homepage: https://docs.openclaw.ai/hooks#session-autosave
metadata:
  {
    "openclaw":
      {
        "emoji": "📝",
        "events": ["session:turn-complete"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# Session Auto-Save Hook

Automatically saves a running session log after each agent turn completes. This creates a searchable archive of your conversations and preserves context that would otherwise be lost during compaction.

## What It Does

After each agent turn:

1. **Reads the latest exchange** - Extracts the last user message and assistant response from the session transcript
2. **Appends to a dated log** - Writes to `<workspace>/memory/sessions/<YYYY-MM-DD>-<session-key-slug>.md`
3. **Tracks metadata** - Records model used, token counts, and whether compaction occurred

## Output Format

Session logs accumulate throughout the day:

```markdown
# Session Log: agent:main:main

## Turn at 14:30:05 UTC (ollama/glm-4.7-flash:latest)

**User:** How do I configure the gateway?

**Assistant:** You can configure the gateway by editing ~/.localclaw/openclaw.local.json...

---
```

## Configuration

| Option     | Type    | Default | Description                                      |
| ---------- | ------- | ------- | ------------------------------------------------ |
| `enabled`  | boolean | true    | Enable/disable auto-save                         |
| `messages` | number  | 2       | Number of recent messages to save per turn        |

Example configuration:

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "session-autosave": {
          "enabled": true,
          "messages": 4
        }
      }
    }
  }
}
```

## Disabling

```bash
openclaw hooks disable session-autosave
```
