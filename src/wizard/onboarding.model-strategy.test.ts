import { describe, expect, it, vi } from "vitest";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import type { OpenClawConfig } from "../config/config.js";
import type { WizardPrompter } from "./prompts.js";

const loadModelCatalog = vi.hoisted(() => vi.fn(async (): Promise<ModelCatalogEntry[]> => []));

vi.mock("../agents/model-catalog.js", () => ({
  loadModelCatalog,
}));

// Mock CLI progress to avoid TTY issues in tests
vi.mock("../cli/progress.js", () => ({
  createCliProgress: vi.fn(() => ({
    setLabel: vi.fn(),
    setPercent: vi.fn(),
    tick: vi.fn(),
    done: vi.fn(),
  })),
}));

// Mock fetch globally for Ollama API calls
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { promptModelStrategy } from "./onboarding.model-strategy.js";

function createSelectMock(responses: string[]): WizardPrompter["select"] {
  let idx = 0;
  return vi.fn(async () => responses[idx++] ?? "") as unknown as WizardPrompter["select"];
}

function createMockPrompter(overrides?: {
  selectResponses?: string[];
  confirmResponses?: boolean[];
}): WizardPrompter {
  const selectResponses = overrides?.selectResponses ?? ["balanced"];
  const confirmResponses = overrides?.confirmResponses ?? [true];
  let confirmIdx = 0;
  const select: WizardPrompter["select"] = createSelectMock(selectResponses);
  return {
    intro: vi.fn(async () => {}),
    outro: vi.fn(async () => {}),
    note: vi.fn(async () => {}),
    select,
    multiselect: vi.fn(async () => []),
    text: vi.fn(async () => ""),
    confirm: vi.fn(async () => confirmResponses[confirmIdx++] ?? true),
    progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
  };
}

describe("promptModelStrategy", () => {
  const baseConfig: OpenClawConfig = {};

  it("balanced strategy sets primary model, fast model, and orchestrator", async () => {
    // Ollama reachable check → not reachable (skip download)
    mockFetch.mockRejectedValue(new Error("not reachable"));

    // Provide some local models in catalog
    loadModelCatalog.mockResolvedValue([
      {
        provider: "ollama",
        id: "gemma3:12b",
        name: "gemma3:12b",
        contextWindow: 8192,
      } as ModelCatalogEntry,
      {
        provider: "ollama",
        id: "llama3.2:latest",
        name: "llama3.2:latest",
        contextWindow: 4096,
      } as ModelCatalogEntry,
    ]);

    const prompter = createMockPrompter({
      selectResponses: [
        "balanced", // strategy
        "ollama/gemma3:12b", // primary model
        "__skip__", // API model (skip)
      ],
      confirmResponses: [
        true, // use default fast model
      ],
    });

    const result = await promptModelStrategy({ config: baseConfig, prompter });

    expect(result.strategy).toBe("balanced");
    expect(result.config.agents?.defaults?.model).toEqual({ primary: "ollama/gemma3:12b" });
    expect(result.config.agents?.defaults?.routing).toEqual({
      enabled: true,
      fastModel: "ollama/llama3.1:8b",
      maxSimpleLength: 250,
    });
  });

  it("local-only strategy disables orchestrator", async () => {
    mockFetch.mockRejectedValue(new Error("not reachable"));

    loadModelCatalog.mockResolvedValue([
      {
        provider: "ollama",
        id: "gemma3:12b",
        name: "gemma3:12b",
        contextWindow: 8192,
      } as ModelCatalogEntry,
    ]);

    const prompter = createMockPrompter({
      selectResponses: [
        "local-only", // strategy
        "ollama/gemma3:12b", // primary model
      ],
      confirmResponses: [true],
    });

    const result = await promptModelStrategy({ config: baseConfig, prompter });

    expect(result.strategy).toBe("local-only");
    expect(result.config.agents?.defaults?.model).toEqual({ primary: "ollama/gemma3:12b" });
    expect(result.config.agents?.defaults?.routing?.enabled).toBe(true);
    expect(result.config.agents?.defaults?.orchestrator).toBeUndefined();
  });

  it("all-api strategy sets orchestrator to always and disables fast routing", async () => {
    loadModelCatalog.mockResolvedValue([]);

    const prompter = createMockPrompter({
      selectResponses: [
        "all-api", // strategy
        "openai/gpt-5.2", // API model
      ],
    });

    const result = await promptModelStrategy({ config: baseConfig, prompter });

    expect(result.strategy).toBe("all-api");
    expect(result.config.agents?.defaults?.model).toEqual({ primary: "openai/gpt-5.2" });
    expect(result.config.agents?.defaults?.routing).toEqual({ enabled: false });
    expect(result.config.agents?.defaults?.orchestrator).toEqual({
      enabled: true,
      model: "openai/gpt-5.2",
      strategy: "always",
    });
  });

  it("falls back to defaults when no local models detected", async () => {
    mockFetch.mockRejectedValue(new Error("not reachable"));
    loadModelCatalog.mockResolvedValue([]);

    const prompter = createMockPrompter({
      selectResponses: ["local-only"],
      confirmResponses: [true],
    });

    const result = await promptModelStrategy({ config: baseConfig, prompter });

    expect(result.strategy).toBe("local-only");
    // Should fall back to default models
    expect(result.config.agents?.defaults?.model).toEqual({ primary: "ollama/gemma3:12b" });
    expect(result.config.agents?.defaults?.routing?.fastModel).toBe("ollama/llama3.1:8b");
  });
});
