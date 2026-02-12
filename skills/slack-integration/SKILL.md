---
name: slack-integration
description: "Interact with Slack workspaces. Use for posting messages, reading channel history, searching messages, or managing Slack channels."
metadata:
  {
    "openclaw":
      {
        "emoji": "💬",
        "requires": { "integrations": ["slack"] },
      },
  }
---

# Slack Integration Skill

Use the built-in `slack_integration` tool to interact with Slack. Do NOT use `exec` or `curl`; call the `slack_integration` tool directly.

## Post a Message

```tool
slack_integration { "action": "post_message", "channel": "general", "text": "Hello team!" }
```

## Read Channel History

```tool
slack_integration { "action": "channel_history", "channel": "general", "limit": 20 }
```

## Get Thread Replies

```tool
slack_integration { "action": "thread_replies", "channel": "general", "threadTs": "1234567890.123456" }
```

## Search Messages

```tool
slack_integration { "action": "search_messages", "query": "search term" }
```

## List Channels

```tool
slack_integration { "action": "list_channels" }
```

## Look Up a User

```tool
slack_integration { "action": "lookup_user", "userId": "U01ABCDEF" }
```

## Add a Reaction

```tool
slack_integration { "action": "add_reaction", "channel": "general", "timestamp": "1234567890.123456", "emoji": "thumbsup" }
```

## Set Channel Topic

```tool
slack_integration { "action": "set_topic", "channel": "general", "topic": "New topic text" }
```
