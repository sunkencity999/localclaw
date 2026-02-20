import { describe, expect, it } from "vitest";
import type { AnyAgentTool } from "../pi-tools.types.js";
import {
  extractTextToolCalls,
  matchToolByName,
  executeTextToolCalls,
  formatTextToolResults,
  extractRawAssistantText,
} from "./text-tool-calls.js";

describe("extractTextToolCalls", () => {
  it("extracts a single tool call with parameters", () => {
    const calls = extractTextToolCalls(
      '{"name": "write", "parameters": {"path": "memory/heartbeat-state.json"}}',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("write");
    expect(calls[0].parameters).toEqual({ path: "memory/heartbeat-state.json" });
  });

  it("extracts a tool call with arguments key", () => {
    const calls = extractTextToolCalls('{"name": "exec", "arguments": {"command": "ls -la"}}');
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("exec");
    expect(calls[0].parameters).toEqual({ command: "ls -la" });
  });

  it("extracts tool calls embedded in text", () => {
    const calls = extractTextToolCalls(
      'Let me check that.\n{"name": "exec", "parameters": {"command": "cat /etc/hosts"}}\nDone.',
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("exec");
  });

  it("extracts multiple tool calls", () => {
    const calls = extractTextToolCalls(
      '{"name": "exec", "parameters": {"cmd": "a"}}\n{"name": "write", "parameters": {"path": "b"}}',
    );
    expect(calls).toHaveLength(2);
    expect(calls[0].name).toBe("exec");
    expect(calls[1].name).toBe("write");
  });

  it("ignores normal JSON objects", () => {
    const calls = extractTextToolCalls('Config: {"port": 8080, "host": "localhost"}');
    expect(calls).toHaveLength(0);
  });

  it("ignores JSON with name but no parameters/arguments", () => {
    const calls = extractTextToolCalls('{"name": "Alice", "age": 30}');
    expect(calls).toHaveLength(0);
  });

  it("returns empty for plain text", () => {
    expect(extractTextToolCalls("Hello, how are you?")).toHaveLength(0);
  });

  it("returns empty for empty string", () => {
    expect(extractTextToolCalls("")).toHaveLength(0);
  });
});

const mockTools: AnyAgentTool[] = [
  {
    name: "exec",
    label: "exec",
    description: "Execute shell commands",
    parameters: {},
    execute: async () => ({
      content: [{ type: "text" as const, text: "command output" }],
      details: {},
    }),
  },
  {
    name: "Write",
    label: "Write",
    description: "Write files",
    parameters: {},
    execute: async () => ({
      content: [{ type: "text" as const, text: "file written" }],
      details: {},
    }),
  },
  {
    name: "Read",
    label: "Read",
    description: "Read files",
    parameters: {},
    execute: async () => ({
      content: [{ type: "text" as const, text: "file contents" }],
      details: {},
    }),
  },
  {
    name: "email",
    label: "Email",
    description: "Email tool",
    parameters: {},
    execute: async () => ({
      content: [{ type: "text" as const, text: "email result" }],
      details: {},
    }),
  },
];

describe("matchToolByName", () => {
  it("matches exact name", () => {
    expect(matchToolByName("exec", mockTools)?.name).toBe("exec");
    expect(matchToolByName("Write", mockTools)?.name).toBe("Write");
  });

  it("matches case-insensitive", () => {
    expect(matchToolByName("Exec", mockTools)?.name).toBe("exec");
    expect(matchToolByName("write", mockTools)?.name).toBe("Write");
    expect(matchToolByName("EMAIL", mockTools)?.name).toBe("email");
  });

  it("matches known aliases", () => {
    expect(matchToolByName("bash", mockTools)?.name).toBe("exec");
    expect(matchToolByName("shell", mockTools)?.name).toBe("exec");
    expect(matchToolByName("run", mockTools)?.name).toBe("exec");
    expect(matchToolByName("terminal", mockTools)?.name).toBe("exec");
    expect(matchToolByName("file_write", mockTools)?.name).toBe("Write");
    expect(matchToolByName("file_read", mockTools)?.name).toBe("Read");
    expect(matchToolByName("read_file", mockTools)?.name).toBe("Read");
    expect(matchToolByName("write_file", mockTools)?.name).toBe("Write");
  });

  it("returns null for unknown names", () => {
    expect(matchToolByName("foobar", mockTools)).toBeNull();
    expect(matchToolByName("deploy", mockTools)).toBeNull();
  });
});

describe("executeTextToolCalls", () => {
  it("executes a matched tool and returns result", async () => {
    const calls = [{ name: "exec", parameters: { command: "ls" } }];
    const results = await executeTextToolCalls(calls, mockTools);
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
    expect(results[0].matchedTool).toBe("exec");
    expect(results[0].output).toBe("command output");
  });

  it("resolves aliases before execution", async () => {
    const calls = [{ name: "bash", parameters: { command: "pwd" } }];
    const results = await executeTextToolCalls(calls, mockTools);
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
    expect(results[0].matchedTool).toBe("exec");
  });

  it("reports unmatched tools", async () => {
    const calls = [{ name: "foobar", parameters: {} }];
    const results = await executeTextToolCalls(calls, mockTools);
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(false);
    expect(results[0].matchedTool).toBeNull();
    expect(results[0].output).toContain("not found");
  });

  it("handles tool execution errors", async () => {
    const failTool: AnyAgentTool = {
      name: "fail",
      label: "fail",
      description: "Always fails",
      parameters: {},
      execute: async () => {
        throw new Error("boom");
      },
    };
    const calls = [{ name: "fail", parameters: {} }];
    const results = await executeTextToolCalls(calls, [failTool]);
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(false);
    expect(results[0].output).toContain("boom");
  });
});

describe("formatTextToolResults", () => {
  it("formats successful results", () => {
    const formatted = formatTextToolResults([
      { toolName: "exec", matchedTool: "exec", output: "hello world", ok: true },
    ]);
    expect(formatted).toContain("[Tool executed: exec]");
    expect(formatted).toContain("hello world");
    expect(formatted).toContain("Do not output raw JSON tool calls");
  });

  it("formats unmatched tool results", () => {
    const formatted = formatTextToolResults([
      { toolName: "foobar", matchedTool: null, output: "not found", ok: false },
    ]);
    expect(formatted).toContain("[Tool not found: foobar]");
  });
});

describe("extractRawAssistantText", () => {
  it("extracts text from content blocks", () => {
    const msg = {
      role: "assistant",
      content: [
        { type: "text", text: "Hello " },
        { type: "text", text: "world" },
      ],
    };
    expect(extractRawAssistantText(msg)).toBe("Hello \nworld");
  });

  it("skips non-text blocks", () => {
    const msg = {
      role: "assistant",
      content: [
        { type: "text", text: "Hello" },
        { type: "tool_call", id: "123" },
      ],
    };
    expect(extractRawAssistantText(msg)).toBe("Hello");
  });

  it("returns empty for null/undefined", () => {
    expect(extractRawAssistantText(null)).toBe("");
    expect(extractRawAssistantText(undefined)).toBe("");
  });
});
