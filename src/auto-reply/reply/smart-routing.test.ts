import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { classifyMessageComplexity, resolveSmartRoute } from "./smart-routing.js";

describe("classifyMessageComplexity", () => {
  it("classifies short conversational messages as simple", () => {
    expect(classifyMessageComplexity("hello").complexity).toBe("simple");
    expect(classifyMessageComplexity("thanks!").complexity).toBe("simple");
    expect(classifyMessageComplexity("how are you?").complexity).toBe("simple");
    expect(classifyMessageComplexity("what time is it?").complexity).toBe("simple");
    expect(classifyMessageComplexity("yes").complexity).toBe("simple");
    expect(classifyMessageComplexity("no").complexity).toBe("simple");
    expect(classifyMessageComplexity("good morning").complexity).toBe("simple");
  });

  it("classifies messages with complex keywords as complex", () => {
    expect(classifyMessageComplexity("fix the bug in auth").complexity).toBe("complex");
    expect(classifyMessageComplexity("create a new file").complexity).toBe("complex");
    expect(classifyMessageComplexity("build the project").complexity).toBe("complex");
    expect(classifyMessageComplexity("debug this error").complexity).toBe("complex");
    expect(classifyMessageComplexity("refactor the function").complexity).toBe("complex");
    expect(classifyMessageComplexity("deploy to production").complexity).toBe("complex");
    expect(classifyMessageComplexity("run the tests").complexity).toBe("complex");
  });

  it("classifies messages with moderate keywords as moderate", () => {
    expect(classifyMessageComplexity("show me my calendar").complexity).toBe("moderate");
    expect(classifyMessageComplexity("list all files").complexity).toBe("moderate");
    expect(classifyMessageComplexity("find the config").complexity).toBe("moderate");
    expect(classifyMessageComplexity("look at that").complexity).toBe("moderate");
    expect(classifyMessageComplexity("inspect the element").complexity).toBe("moderate");
    expect(classifyMessageComplexity("open the dashboard").complexity).toBe("moderate");
    expect(classifyMessageComplexity("verify the status").complexity).toBe("moderate");
  });

  it("classifies external-leaning tool calls as complex", () => {
    expect(classifyMessageComplexity("search my email").complexity).toBe("complex");
    expect(classifyMessageComplexity("read the latest message").complexity).toBe("complex");
    expect(classifyMessageComplexity("send a message to John").complexity).toBe("complex");
    expect(classifyMessageComplexity("check my Jira issues").complexity).toBe("complex");
    expect(classifyMessageComplexity("summarize that article").complexity).toBe("complex");
    expect(classifyMessageComplexity("fetch the API data").complexity).toBe("complex");
    expect(classifyMessageComplexity("download the report").complexity).toBe("complex");
  });

  it("classifies messages with code blocks as complex", () => {
    expect(classifyMessageComplexity("```\nconst x = 1;\n```").complexity).toBe("complex");
  });

  it("classifies messages with file paths as complex", () => {
    expect(classifyMessageComplexity("look at /src/index.ts").complexity).toBe("complex");
    expect(classifyMessageComplexity("check ~/config.json").complexity).toBe("complex");
  });

  it("classifies messages with URLs as complex", () => {
    expect(classifyMessageComplexity("fetch https://example.com/api").complexity).toBe("complex");
  });

  it("classifies multi-sentence messages as complex", () => {
    expect(
      classifyMessageComplexity("First do this. Then do that. Finally check the result.")
        .complexity,
    ).toBe("complex");
  });

  it("classifies slash commands as complex", () => {
    expect(classifyMessageComplexity("/new").complexity).toBe("complex");
    expect(classifyMessageComplexity("/model ollama/qwen3").complexity).toBe("complex");
  });

  it("classifies tool-requiring resource keywords as moderate", () => {
    expect(
      classifyMessageComplexity(
        "Do I have any work emails in my inbox from today I should address?",
      ).complexity,
    ).toBe("moderate");
    expect(classifyMessageComplexity("any unread emails?").complexity).toBe("moderate");
    expect(classifyMessageComplexity("what's on my calendar today?").complexity).toBe("moderate");
    expect(classifyMessageComplexity("do I have any meetings?").complexity).toBe("moderate");
    expect(classifyMessageComplexity("what's the weather?").complexity).toBe("moderate");
    expect(classifyMessageComplexity("check my inbox").complexity).toBe("complex"); // "check" is complex
  });

  it("classifies empty messages as simple", () => {
    expect(classifyMessageComplexity("").complexity).toBe("simple");
    expect(classifyMessageComplexity("   ").complexity).toBe("simple");
  });

  it("classifies affirmative confirmations with follow-up as moderate", () => {
    expect(
      classifyMessageComplexity("Yes. Please do so for all of the labels we have created today.")
        .complexity,
    ).toBe("moderate");
    expect(classifyMessageComplexity("Yes, go ahead").complexity).toBe("moderate");
    expect(classifyMessageComplexity("Sure, do that").complexity).toBe("moderate");
    expect(classifyMessageComplexity("Ok please proceed").complexity).toBe("moderate");
    expect(classifyMessageComplexity("Yeah that would be great").complexity).toBe("moderate");
  });

  it("classifies bare action-implying affirmatives as moderate", () => {
    expect(classifyMessageComplexity("go ahead").complexity).toBe("moderate");
    expect(classifyMessageComplexity("do it").complexity).toBe("moderate");
    expect(classifyMessageComplexity("proceed").complexity).toBe("moderate");
    expect(classifyMessageComplexity("sounds good").complexity).toBe("moderate");
    expect(classifyMessageComplexity("let's do it").complexity).toBe("moderate");
    expect(classifyMessageComplexity("make it so").complexity).toBe("moderate");
  });

  it("keeps bare ambiguous single-word affirmatives as simple", () => {
    expect(classifyMessageComplexity("yes").complexity).toBe("simple");
    expect(classifyMessageComplexity("ok").complexity).toBe("simple");
    expect(classifyMessageComplexity("sure").complexity).toBe("simple");
    expect(classifyMessageComplexity("yeah").complexity).toBe("simple");
    expect(classifyMessageComplexity("perfect").complexity).toBe("simple");
  });

  it("classifies filter/label/apply/archive keywords as moderate", () => {
    expect(classifyMessageComplexity("apply the filters").complexity).toBe("moderate");
    expect(classifyMessageComplexity("add the Veeam label to those messages").complexity).toBe(
      "moderate",
    );
    expect(classifyMessageComplexity("archive those messages").complexity).toBe("moderate");
    expect(classifyMessageComplexity("apply retroactively").complexity).toBe("moderate");
  });
});

describe("resolveSmartRoute", () => {
  const baseCfg = {
    agents: {
      defaults: {
        routing: {
          enabled: true,
          fastModel: "ollama/qwen3:1.7b",
        },
      },
    },
  };

  it("routes simple messages to the fast model", () => {
    const result = resolveSmartRoute({
      message: "hello",
      cfg: baseCfg as unknown as OpenClawConfig,
      currentProvider: "ollama",
      currentModel: "glm-4.7-flash:latest",
      defaultProvider: "ollama",
    });
    expect(result.routed).toBe(true);
    expect(result.provider).toBe("ollama");
    expect(result.model).toBe("qwen3:1.7b");
    expect(result.complexity).toBe("simple");
  });

  it("does not route complex messages", () => {
    const result = resolveSmartRoute({
      message: "fix the bug in /src/auth.ts",
      cfg: baseCfg as unknown as OpenClawConfig,
      currentProvider: "ollama",
      currentModel: "glm-4.7-flash:latest",
      defaultProvider: "ollama",
    });
    expect(result.routed).toBe(false);
    expect(result.model).toBe("glm-4.7-flash:latest");
    expect(result.complexity).toBe("complex");
  });

  it("does not route moderate messages to the fast model", () => {
    const result = resolveSmartRoute({
      message: "show me the status",
      cfg: baseCfg as unknown as OpenClawConfig,
      currentProvider: "ollama",
      currentModel: "glm-4.7-flash:latest",
      defaultProvider: "ollama",
    });
    expect(result.routed).toBe(false);
    expect(result.model).toBe("glm-4.7-flash:latest");
    expect(result.complexity).toBe("moderate");
  });

  it("does not route when routing is disabled", () => {
    const cfg = {
      agents: {
        defaults: {
          routing: { enabled: false, fastModel: "ollama/qwen3:1.7b" },
        },
      },
    };
    const result = resolveSmartRoute({
      message: "hello",
      cfg: cfg as unknown as OpenClawConfig,
      currentProvider: "ollama",
      currentModel: "glm-4.7-flash:latest",
      defaultProvider: "ollama",
    });
    expect(result.routed).toBe(false);
  });

  it("does not route when no fast model is configured", () => {
    const cfg = { agents: { defaults: { routing: { enabled: true } } } };
    const result = resolveSmartRoute({
      message: "hello",
      cfg: cfg as unknown as OpenClawConfig,
      currentProvider: "ollama",
      currentModel: "glm-4.7-flash:latest",
      defaultProvider: "ollama",
    });
    expect(result.routed).toBe(false);
  });

  it("does not route messages exceeding maxSimpleLength", () => {
    const cfg = {
      agents: {
        defaults: {
          routing: { enabled: true, fastModel: "ollama/qwen3:1.7b", maxSimpleLength: 10 },
        },
      },
    };
    const result = resolveSmartRoute({
      message: "this is a longer message",
      cfg: cfg as unknown as OpenClawConfig,
      currentProvider: "ollama",
      currentModel: "glm-4.7-flash:latest",
      defaultProvider: "ollama",
    });
    expect(result.routed).toBe(false);
    expect(result.complexity).toBe("complex");
  });

  it("routes 'are you with me?' to the fast model (simple conversational)", () => {
    const result = resolveSmartRoute({
      message: "are you with me?",
      cfg: baseCfg as unknown as OpenClawConfig,
      currentProvider: "ollama",
      currentModel: "glm-4.7-flash:latest",
      defaultProvider: "ollama",
    });
    expect(result.routed).toBe(true);
    expect(result.provider).toBe("ollama");
    expect(result.model).toBe("qwen3:1.7b");
    expect(result.complexity).toBe("simple");
  });

  it("exposes fastModelContextTokens config for context capping", () => {
    const cfg = {
      agents: {
        defaults: {
          routing: {
            enabled: true,
            fastModel: "ollama/qwen3:1.7b",
            fastModelContextTokens: 2048,
          },
        },
      },
    };
    const routing = cfg.agents.defaults.routing;
    const fastCap = routing.fastModelContextTokens ?? 4096;
    expect(fastCap).toBe(2048);
  });

  it("defaults fastModelContextTokens to 4096 when not configured", () => {
    const routing = baseCfg.agents.defaults.routing;
    const fastCap = (routing as Record<string, unknown>).fastModelContextTokens ?? 4096;
    expect(fastCap).toBe(4096);
  });
});
