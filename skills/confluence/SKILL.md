---
name: confluence
description: "Search and manage Confluence pages and spaces. Use for any request about wiki pages, documentation, or Confluence content."
metadata:
  {
    "openclaw":
      {
        "emoji": "📖",
        "requires": { "integrations": ["confluence"] },
      },
  }
---

# Confluence Skill

Use the built-in `confluence` tool to interact with Confluence. Do NOT use `exec` or `curl`; call the `confluence` tool directly.

## Search Pages

```tool
confluence { "action": "search", "cql": "text ~ 'search term' ORDER BY lastmodified DESC", "maxResults": 10 }
```

## Get a Page

```tool
confluence { "action": "get_page", "pageId": "12345" }
```

## Get Page Body (Full Content)

```tool
confluence { "action": "get_page_body", "pageId": "12345" }
```

## Create a Page

```tool
confluence { "action": "create_page", "spaceKey": "TEAM", "title": "Page Title", "body": "<p>Page content in HTML</p>" }
```

## Update a Page

```tool
confluence { "action": "update_page", "pageId": "12345", "title": "Updated Title", "body": "<p>Updated content</p>", "version": 2 }
```

## List Spaces

```tool
confluence { "action": "list_spaces" }
```
