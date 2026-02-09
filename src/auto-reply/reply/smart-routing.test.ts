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

  it("classifies empty messages as simple", () => {
    expect(classifyMessageComplexity("").complexity).toBe("simple");
    expect(classifyMessageComplexity("   ").complexity).toBe("simple");
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
});
