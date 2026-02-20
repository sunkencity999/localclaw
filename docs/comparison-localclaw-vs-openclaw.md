# LocalClaw vs OpenClaw — Direct Comparison

LocalClaw is a fork of [OpenClaw](https://github.com/openclaw/openclaw) optimized for **local-first AI workflows**. It inherits the full OpenClaw platform but adds significant local model intelligence on top. This document compares the two side by side.

## At a Glance

| | OpenClaw | LocalClaw |
|---|---|---|
| **Primary focus** | Cloud API models (OpenAI, Anthropic, Google) | Local models (Ollama, LM Studio, vLLM) with optional API fallback |
| **Binary** | `openclaw` | `localclaw` |
| **Config** | `~/.openclaw/openclaw.json` | `~/.localclaw/openclaw.local.json` |
| **Default gateway port** | 18789 | 18790 |
| **State directory** | `~/.openclaw/` | `~/.localclaw/` |
| **Coexistence** | N/A | Runs side-by-side with OpenClaw, fully isolated |
| **Cloud keys required** | Yes (for primary use) | No (optional for orchestrator fallback) |

## Feature Comparison

### Model Routing and Fallback

| Feature | OpenClaw | LocalClaw |
|---------|----------|-----------|
| **Model tiers** | Single model or manual fallback list | Three-tier automatic routing (fast/primary/orchestrator) |
| **Message classification** | None — all messages go to the same model | Heuristic classifier routes simple/moderate/complex messages to different tiers |
| **Fast model tier** | Not available | Sub-second responses for greetings and short chat via tiny local model (e.g. 3B) with tools disabled |
| **Tiered timeouts** | Fixed timeout (configurable) | **4 min** for local with API fallback, **10 min** for local-only — automatic |
| **Auto-escalation on timeout** | Manual fallback list only | Local model timeout automatically escalates to API orchestrator |
| **Orchestrator fallback** | `fallback-only` strategy only | Available in both `auto` and `fallback-only` strategies |
| **Strategy presets** | Manual config | Onboarding wizard offers Balanced / Local-only / All-API presets |

### Local Model Compatibility

| Feature | OpenClaw | LocalClaw |
|---------|----------|-----------|
| **Text-based tool call recovery** | Not available | Detects raw JSON tool calls in model output, matches to tools, executes transparently |
| **Fuzzy tool name matching** | Not available | Aliases and fuzzy matching for tool names (e.g. `bash` → `exec`) |
| **Structured tool call guard** | N/A | Text-tool-call interception only fires for local providers and only when no structured calls were made |
| **Tool prioritization** | Standard descriptions | Priority hints guide models to prefer structured tools over shell commands (e.g. `email` over `exec`) |

### Context Management

| Feature | OpenClaw | LocalClaw |
|---------|----------|-----------|
| **Context pruning** | Cache-TTL based, cloud-optimized | Always-on aggressive pruning optimized for small context windows (8K-32K) |
| **Tool result trimming** | Starts at higher thresholds | Soft-trim at 20%, hard-clear at 40%, 2K char cap per result |
| **Compaction** | 50% history share, 20K reserve floor | 30% history share, 2K reserve floor |
| **Memory persistence** | Standard | Proactive — writes `memory/state.md` after every meaningful step |
| **Fast model context** | N/A | Injects compact `state.md` snapshot (800 chars) into fast model system prompt |
| **Bootstrap budget** | Standard | Capped at 8K chars to maximize conversation space |

### Startup and Health

| Feature | OpenClaw | LocalClaw |
|---------|----------|-----------|
| **Model server validation** | Basic | Full stack validation on every boot: server reachability, model availability, context window check |
| **First-run onboarding** | API key focused | Detects local model servers, lists available models, configures flash attention |
| **TUI status bar** | Model info | Shows all three tiers: active model, primary, orchestrator, strategy, token usage |

### Tools and Integrations

| Feature | OpenClaw | LocalClaw |
|---------|----------|-----------|
| **Core agent tools** | Standard set | Same 10+ native tools (exec, email, pdf, office, media, git, network, etc.) |
| **Email (Gmail)** | Not built-in | Native multi-account Gmail via `gog` CLI with search, read, send, reply, archive, label management |
| **Jira** | Not built-in | Native Jira Cloud and Server/Data Center integration |
| **Confluence** | Not built-in | Native Confluence search, read, create, update |
| **Slack integration** | Channel only | Channel + integration tool (read/write DMs, search, post as yourself) |
| **Multi-channel messaging** | 14+ channels | Same 14+ channels (Telegram, WhatsApp, Discord, Slack, Signal, iMessage, etc.) |

### Proactive Intelligence

| Feature | OpenClaw | LocalClaw |
|---------|----------|-----------|
| **Session auto-save** | Not built-in | Every turn logged to `memory/sessions/` as timestamped markdown |
| **Session browser** | Not available | Web UI at `/sessions` with full-text search |
| **Proactive briefing** | Not built-in | Reads last 24h session logs on startup, writes context summary for morning briefings |
| **User learning** | Not built-in | Observes active hours, message style, tool preferences, topic frequency |
| **Workflow engine** | Not built-in | YAML-based event/schedule triggered workflows with agent-turn, notify, write-file steps |
| **Workspace file watcher** | Not available | Monitors workspace files, fires hook events with debouncing |

### Deep OS Integration

| Feature | OpenClaw | LocalClaw |
|---------|----------|-----------|
| **Clipboard** | Not built-in | Full read/write clipboard access |
| **Focus mode** | Not available | Suppress heartbeat delivery during deep work, auto-expiry, buffered alerts |
| **Document indexer** | Not built-in | Auto-indexes text files from `workspace/documents/` |
| **Diagram pipeline** | Not available | Detects Mermaid blocks, renders to SVG |
| **Voice pipeline** | Not built-in | STT via whisper-cpp, TTS via macOS say |

## What LocalClaw Does NOT Change

LocalClaw inherits and preserves the full OpenClaw platform without modification:

- **Agent runtime** — same Pi-embedded runner, session management, agent-to-agent coordination
- **Gateway architecture** — same WebSocket control plane, RPC, event system
- **Tool execution** — same bash, browser, canvas, cron, nodes infrastructure
- **Security model** — same DM pairing, allowlists, tool policies
- **Plugin system** — same extension architecture for channels and integrations
- **Browser control** — same CDP-based Chrome/Chromium control
- **Skills system** — same bundled, managed, and workspace skills

## When to Use Which

| Use case | Recommendation |
|----------|---------------|
| Privacy-first, air-gapped, or no API budget | **LocalClaw** (local-only preset) |
| Local models for routine tasks, API for complex ones | **LocalClaw** (balanced preset) |
| Maximum quality, unlimited API budget | Either — OpenClaw is simpler; LocalClaw adds routing overhead |
| Cloud-only with no local models | **OpenClaw** — LocalClaw's local optimizations add no value |
| Multi-channel messaging without local models | **OpenClaw** — lighter weight for cloud-only setups |
| Email, Jira, Confluence, Slack integration | **LocalClaw** — built-in structured tools |
| Proactive briefings, session history, user learning | **LocalClaw** — not available in OpenClaw |

## Architecture Diagram

```
                    ┌─────────────────────────────────┐
                    │      Message Classifier          │
                    │   (simple/moderate/complex)       │
                    └──────┬──────┬──────┬─────────────┘
                           │      │      │
                    ┌──────▼──┐ ┌─▼────┐ ┌▼──────────┐
                    │ Fast    │ │Local │ │ API        │
                    │ (3B)   │ │(8-30B)│ │Orchestrator│
                    │ no tools│ │tools │ │ tools      │
                    └─────────┘ └──┬───┘ └────────────┘
                                   │          ▲
                                   │ timeout  │
                                   └──────────┘
                                auto-escalation
```

## Summary

**OpenClaw** is the full-featured personal AI assistant platform, designed primarily for cloud API models.

**LocalClaw** takes that same platform and adds a local-first intelligence layer:
- Three-tier model routing with per-message classification
- Tiered timeouts with automatic API escalation
- Text-based tool call recovery for models with poor native tool support
- Aggressive context management for small context windows
- Proactive memory, learning, and briefing systems
- Native integrations for email, Jira, Confluence, and Slack

Both run on the same codebase. LocalClaw is a superset — everything OpenClaw can do, LocalClaw can do too, with additional optimizations for local model workflows.
