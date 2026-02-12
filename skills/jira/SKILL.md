---
name: jira
description: "Search and manage Jira issues. Use for any request about Jira issues, tickets, sprints, or project tracking."
metadata:
  {
    "openclaw":
      {
        "emoji": "🎫",
        "requires": { "integrations": ["jira"] },
      },
  }
---

# Jira Skill

Use the built-in `jira` tool to interact with Jira. Do NOT use `exec` or `curl`; call the `jira` tool directly.

## Check My Issues / Queue

```tool
jira { "action": "search", "jql": "assignee = currentUser() AND status != Done ORDER BY updated DESC" }
```

## Search Issues by JQL

```tool
jira { "action": "search", "jql": "project = PROJ AND status = 'In Progress'", "maxResults": 20 }
```

## Get a Specific Issue

```tool
jira { "action": "get_issue", "issueKey": "PROJ-123" }
```

## Create an Issue

```tool
jira { "action": "create_issue", "project": "PROJ", "summary": "Issue title", "description": "Details here", "issueType": "Task" }
```

## Add a Comment

```tool
jira { "action": "add_comment", "issueKey": "PROJ-123", "comment": "Comment text" }
```

## Transition an Issue (Change Status)

First get available transitions:

```tool
jira { "action": "get_transitions", "issueKey": "PROJ-123" }
```

Then apply the transition:

```tool
jira { "action": "transition_issue", "issueKey": "PROJ-123", "transitionId": "31" }
```
