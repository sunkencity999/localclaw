/**
 * Text-based tool call extraction and execution for models that output
 * tool calls as plain JSON text instead of using the structured API format.
 *
 * Some local models (e.g. GLM-4 via Ollama) have "tools" in their reported
 * capabilities but their chat templates lack native tool calling support.
 * They see the tool definitions in their context and attempt to call them
 * by emitting raw JSON like: {"name": "exec", "parameters": {"command": "ls"}}
 *
 * This module extracts those text-based calls, matches them to registered
 * tools, executes them, and formats results so the model can see the output.
 */

import type { AnyAgentTool } from "../pi-tools.types.js";
import { log } from "./logger.js";

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

export type TextToolCall = {
  name: string;
  parameters: Record<string, unknown>;
};

/**
 * Extract raw JSON tool call objects from assistant text.
 *
 * Matches patterns like:
 *   {"name": "exec", "parameters": {"command": "ls"}}
 *   {"name": "write", "arguments": {"path": "foo.txt", "content": "..."}}
 */
export function extractTextToolCalls(text: string): TextToolCall[] {
  if (!text || !text.includes('"name"')) {
    return [];
  }

  const calls: TextToolCall[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const braceIdx = text.indexOf("{", cursor);
    if (braceIdx === -1) break;

    const end = findBalancedBrace(text, braceIdx);
    if (end === null) {
      cursor = braceIdx + 1;
      continue;
    }

    const candidate = text.slice(braceIdx, end);
    const parsed = parseToolCall(candidate);
    if (parsed) {
      calls.push(parsed);
    }
    cursor = end;
  }

  return calls;
}

function findBalancedBrace(text: string, start: number): number | null {
  if (text[start] !== "{") return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      depth++;
      continue;
    }
    if (ch === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return null;
}

function parseToolCall(json: string): TextToolCall | null {
  try {
    const obj = JSON.parse(json);
    if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;
    if (typeof obj.name !== "string" || !obj.name.trim()) return null;

    const params =
      (typeof obj.parameters === "object" &&
      obj.parameters !== null &&
      !Array.isArray(obj.parameters)
        ? obj.parameters
        : null) ??
      (typeof obj.arguments === "object" && obj.arguments !== null && !Array.isArray(obj.arguments)
        ? obj.arguments
        : null) ??
      (typeof obj.params === "object" && obj.params !== null && !Array.isArray(obj.params)
        ? obj.params
        : null);

    if (!params) return null;

    return { name: obj.name.trim(), parameters: params as Record<string, unknown> };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tool name matching
// ---------------------------------------------------------------------------

/**
 * Common aliases that models hallucinate → real tool names.
 * Keys are lowercase; values are the canonical tool names.
 */
const TOOL_NAME_ALIASES: Record<string, string> = {
  // Shell/exec variants
  shell: "exec",
  bash: "exec",
  run: "exec",
  terminal: "exec",
  command: "exec",
  execute: "exec",
  sh: "exec",
  cmd: "exec",
  run_command: "exec",
  run_shell: "exec",
  // File variants
  file_write: "Write",
  file_read: "Read",
  write_file: "Write",
  read_file: "Read",
  create_file: "Write",
  save_file: "Write",
  write: "Write",
  read: "Read",
  edit: "Edit",
  file_edit: "Edit",
  edit_file: "Edit",
  patch: "Edit",
  apply_patch: "apply_patch",
  // Search variants
  search: "search",
  grep: "search",
  find: "search",
};

/**
 * Find a registered tool matching a (possibly hallucinated) name.
 *
 * Match priority:
 * 1. Exact name match
 * 2. Case-insensitive match
 * 3. Known alias → canonical name
 */
export function matchToolByName(name: string, tools: AnyAgentTool[]): AnyAgentTool | null {
  // 1. Exact match
  const exact = tools.find((t) => t.name === name);
  if (exact) return exact;

  // 2. Case-insensitive match
  const lower = name.toLowerCase();
  const ci = tools.find((t) => t.name.toLowerCase() === lower);
  if (ci) return ci;

  // 3. Alias lookup
  const canonical = TOOL_NAME_ALIASES[lower];
  if (canonical) {
    const aliased = tools.find(
      (t) => t.name === canonical || t.name.toLowerCase() === canonical.toLowerCase(),
    );
    if (aliased) return aliased;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export type TextToolCallResult = {
  toolName: string;
  matchedTool: string | null;
  output: string;
  ok: boolean;
};

/**
 * Execute a list of text-based tool calls against registered tools.
 */
export async function executeTextToolCalls(
  calls: TextToolCall[],
  tools: AnyAgentTool[],
  signal?: AbortSignal,
): Promise<TextToolCallResult[]> {
  const results: TextToolCallResult[] = [];

  for (const call of calls) {
    if (signal?.aborted) break;

    const tool = matchToolByName(call.name, tools);
    if (!tool) {
      log.warn(`text-tool-call: no matching tool for "${call.name}"`);
      results.push({
        toolName: call.name,
        matchedTool: null,
        output: `Tool "${call.name}" not found. Available tools: ${tools.map((t) => t.name).join(", ")}`,
        ok: false,
      });
      continue;
    }

    log.info(
      `text-tool-call: executing "${tool.name}" (requested as "${call.name}") with ${JSON.stringify(call.parameters).slice(0, 200)}`,
    );

    try {
      const result = await tool.execute(`text-tc-${Date.now()}`, call.parameters, signal);
      const text = extractResultText(result);
      results.push({
        toolName: call.name,
        matchedTool: tool.name,
        output: text,
        ok: true,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`text-tool-call: "${tool.name}" failed: ${message}`);
      results.push({
        toolName: call.name,
        matchedTool: tool.name,
        output: `Error: ${message}`,
        ok: false,
      });
    }
  }

  return results;
}

function extractResultText(result: unknown): string {
  if (!result || typeof result !== "object") return String(result ?? "");
  const rec = result as Record<string, unknown>;

  // AgentToolResult shape: { content: [{ type: "text", text: "..." }, ...] }
  if (Array.isArray(rec.content)) {
    const texts = rec.content
      .filter(
        (block: unknown): block is { type: "text"; text: string } =>
          !!block &&
          typeof block === "object" &&
          (block as Record<string, unknown>).type === "text" &&
          typeof (block as Record<string, unknown>).text === "string",
      )
      .map((block) => block.text);
    if (texts.length > 0) return texts.join("\n");
  }

  return JSON.stringify(result, null, 2);
}

// ---------------------------------------------------------------------------
// Result formatting
// ---------------------------------------------------------------------------

/**
 * Format tool results as a prompt message the model can understand.
 */
export function formatTextToolResults(results: TextToolCallResult[]): string {
  const parts = results.map((r) => {
    const header = r.matchedTool
      ? `[Tool executed: ${r.matchedTool}]`
      : `[Tool not found: ${r.toolName}]`;
    return `${header}\n${truncateOutput(r.output, 8000)}`;
  });

  return [
    "I executed the tool call(s) you requested. Here are the results:",
    "",
    ...parts,
    "",
    "Please summarize the result for the user. Do not output raw JSON tool calls.",
  ].join("\n");
}

function truncateOutput(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}\n... [truncated, ${text.length - maxLen} chars omitted]`;
}

// ---------------------------------------------------------------------------
// Assistant message text extraction (lightweight, no stripping)
// ---------------------------------------------------------------------------

/**
 * Extract raw text from an assistant message's content blocks.
 * Does NOT strip tool calls — we need the raw text to detect them.
 */
export function extractRawAssistantText(msg: unknown): string {
  if (!msg || typeof msg !== "object") return "";
  const rec = msg as Record<string, unknown>;
  if (!Array.isArray(rec.content)) return "";
  return rec.content
    .filter(
      (block: unknown): block is { type: "text"; text: string } =>
        !!block &&
        typeof block === "object" &&
        (block as Record<string, unknown>).type === "text" &&
        typeof (block as Record<string, unknown>).text === "string",
    )
    .map((block) => block.text)
    .join("\n")
    .trim();
}
