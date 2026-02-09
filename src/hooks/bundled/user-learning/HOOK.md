---
name: user-learning
description: "Learn user preferences from interactions — style, tools, schedule"
homepage: https://docs.openclaw.ai/hooks#user-learning
metadata:
  {
    "openclaw":
      {
        "emoji": "🧠",
        "events": ["session:turn-complete"],
        "requires": { "config": ["workspace.dir"] },
        "install": [{ "id": "bundled", "kind": "bundled", "label": "Bundled with OpenClaw" }],
      },
  }
---

# User Learning Hook

Observes user interactions and builds a personalized preference profile over time.

## What It Tracks

- **Active hours** — when the user typically sends messages
- **Message style** — average length, question frequency
- **Tool preferences** — which tools/actions are requested most
- **Topic frequency** — common themes in conversations

## Storage

Preferences are stored at `<workspace>/memory/user-preferences.json` and updated after each agent turn.

## How It Works

After each `session:turn-complete` event, the hook:

1. Loads the current preferences from disk
2. Analyzes the user message for patterns
3. Updates frequency counters and averages
4. Saves the updated preferences

The preferences file can be referenced by other hooks (e.g., proactive-briefing) to personalize behavior.
