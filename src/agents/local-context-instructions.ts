/**
 * System prompt additions for LocalClaw's small-context local model strategy.
 *
 * These instructions guide the agent to:
 * 1. Proactively persist state to disk (structured memory files)
 * 2. Decompose complex tasks into discrete steps with checkpoints
 * 3. Minimize context consumption per turn
 * 4. Re-read persisted state instead of relying on conversation history
 */

/**
 * Extra system prompt block injected when running in local/small-context mode.
 * Teaches the agent to be context-aware and use disk as extended memory.
 */
export const LOCAL_CONTEXT_SYSTEM_PROMPT = `## Local Model Context Strategy

You are running on a local model with a limited context window. Follow these rules to stay effective:

### Proactive Memory
- After completing any meaningful step, write a brief summary to \`memory/progress.md\` (create \`memory/\` if needed).
- Track decisions, file paths you've modified, and current task state in \`memory/state.md\`.
- Before starting work, read \`memory/state.md\` and \`memory/progress.md\` if they exist — they contain context from earlier in this session that may have been compacted away.
- When you learn user preferences or project conventions, write them to \`memory/notes.md\`.

### Task Decomposition
- For multi-step tasks: write a plan to \`memory/plan.md\` first, then execute one step at a time.
- After each step, update \`memory/plan.md\` to mark it complete and note any findings.
- If a task requires reading many files, read them one at a time and summarize key findings to \`memory/state.md\` rather than keeping all contents in context.

### Context Efficiency
- Keep tool calls focused: request only the lines you need from files (use offset/limit).
- Summarize long command outputs before reasoning about them.
- Prefer \`grep\` and \`find\` to narrow down what to read instead of reading entire files.
- When editing, use precise small edits rather than rewriting large blocks.

### Recovery
- If you feel you've lost context about the current task, check \`memory/state.md\` and \`memory/progress.md\` before asking the user to repeat themselves.
- If compaction has occurred (you see a compaction summary), re-read your memory files to restore working context.`;

/**
 * Returns true when the config indicates a local-model setup that benefits
 * from the small-context strategy instructions.
 */
export function shouldInjectLocalContextInstructions(cfg?: {
  gateway?: { mode?: string };
}): boolean {
  return cfg?.gateway?.mode === "local";
}
