import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import type { OpenClawConfig } from "../config/config.js";
import type { WizardPrompter } from "./prompts.js";
import { loadModelCatalog } from "../agents/model-catalog.js";
import { modelKey, normalizeProviderId } from "../agents/model-selection.js";
import { createCliProgress } from "../cli/progress.js";
import { isLocalModelProvider, LOCAL_MODEL_PROVIDERS } from "../commands/model-picker.js";

// ── Constants ────────────────────────────────────────────────────────────────

const OLLAMA_API_BASE = "http://127.0.0.1:11434";

/** Default tiny model for fast-tier routing (chat, greetings). */
const DEFAULT_FAST_MODEL = "ollama/llama3.2:latest";
/** Default local primary model for moderate-tier (tool calls, lookups). */
const DEFAULT_LOCAL_MODEL = "ollama/gemma3:12b";

/** Well-known orchestrator models for the API-tier picker. */
const WELL_KNOWN_API_MODELS: Array<{ value: string; hint: string }> = [
  { value: "openai-codex/gpt-5.2-codex", hint: "advanced coding, real-world engineering" },
  { value: "openai/gpt-5.2", hint: "best general agentic model" },
  { value: "openai/gpt-4.1", hint: "1M ctx, strong reasoning" },
  { value: "openai/gpt-4.1-mini", hint: "1M ctx, fast + affordable" },
  { value: "anthropic/claude-sonnet-4-5", hint: "up to 1M ctx, strong + fast" },
  { value: "anthropic/claude-sonnet-4", hint: "200K ctx, fast + capable" },
  { value: "anthropic/claude-opus-4", hint: "200K ctx, deep reasoning" },
  { value: "google/gemini-2.5-pro", hint: "1M ctx, strong reasoning" },
  { value: "google/gemini-2.5-flash", hint: "1M ctx, fast + affordable" },
];

export type ModelStrategy = "balanced" | "local-only" | "all-api";

export type ModelStrategyResult = {
  strategy: ModelStrategy;
  config: OpenClawConfig;
};

// ── Strategy preset prompt ───────────────────────────────────────────────────

export async function promptModelStrategy(params: {
  config: OpenClawConfig;
  prompter: WizardPrompter;
}): Promise<ModelStrategyResult> {
  const { prompter } = params;
  let config = params.config;

  await prompter.note(
    [
      "LocalClaw uses three tiers to route messages to the right model:",
      "",
      "  Fast (tiny)   — greetings, yes/no → small local model (sub-second)",
      "  Local (primary) — lookups, tool calls → capable local model",
      "  API (complex)  — reasoning, code, external APIs → cloud API model",
      "",
      "Choose a strategy preset below. You can customize individual models afterward.",
    ].join("\n"),
    "Model strategy",
  );

  const strategy = await prompter.select<ModelStrategy>({
    message: "Model strategy",
    options: [
      {
        value: "balanced",
        label: "Balanced (recommended)",
        hint: "Local for chat + tools, API for complex tasks",
      },
      {
        value: "local-only",
        label: "Local only",
        hint: "Privacy-first, no API dependency",
      },
      {
        value: "all-api",
        label: "All-API (Enterprise)",
        hint: "Maximum quality, unlimited token budget",
      },
    ],
    initialValue: "balanced",
  });

  let catalog: ModelCatalogEntry[];
  try {
    catalog = await loadModelCatalog({ config, useCache: false });
  } catch {
    await prompter.note(
      [
        "Could not load the model catalog (Ollama may not be running).",
        "Proceeding with defaults — you can reconfigure later via:",
        "  localclaw configure --section models",
      ].join("\n"),
      "Catalog unavailable",
    );
    catalog = [];
  }

  if (strategy === "all-api") {
    config = await applyAllApiStrategy({ config, prompter, catalog });
  } else {
    config = await applyLocalStrategy({ config, prompter, catalog, strategy });
  }

  return { strategy, config };
}

// ── All-API strategy ─────────────────────────────────────────────────────────

async function applyAllApiStrategy(params: {
  config: OpenClawConfig;
  prompter: WizardPrompter;
  catalog: ModelCatalogEntry[];
}): Promise<OpenClawConfig> {
  const { prompter, catalog } = params;
  let config = params.config;

  const apiModel = await promptApiModel({
    prompter,
    catalog,
    message: "API model (used for all tiers)",
  });
  if (!apiModel) {
    return config;
  }

  // Primary = API model, orchestrator = always, no fast model needed
  config = {
    ...config,
    agents: {
      ...config.agents,
      defaults: {
        ...config.agents?.defaults,
        model: { primary: apiModel },
        routing: { enabled: false },
        orchestrator: {
          enabled: true,
          model: apiModel,
          strategy: "always",
        },
      },
    },
  };

  await prompter.note(
    [
      "All-API strategy configured:",
      `  Primary model: ${apiModel}`,
      `  Orchestrator: always (API first, no local fallback)`,
      "  Fast routing: disabled (API handles everything)",
    ].join("\n"),
    "Strategy applied",
  );

  return config;
}

// ── Local / Balanced strategy ────────────────────────────────────────────────

async function applyLocalStrategy(params: {
  config: OpenClawConfig;
  prompter: WizardPrompter;
  catalog: ModelCatalogEntry[];
  strategy: "balanced" | "local-only";
}): Promise<OpenClawConfig> {
  const { prompter, catalog, strategy } = params;
  let config = params.config;

  // 1. Pick primary local model
  const localModels = catalog.filter((e) =>
    LOCAL_MODEL_PROVIDERS.includes(
      normalizeProviderId(e.provider) as (typeof LOCAL_MODEL_PROVIDERS)[number],
    ),
  );

  let primaryModel: string | undefined;
  if (localModels.length > 0) {
    const options = localModels.slice(0, 25).map((m) => ({
      value: modelKey(m.provider, m.id),
      label: modelKey(m.provider, m.id),
      hint: m.contextWindow ? `${Math.round(m.contextWindow / 1024)}K ctx` : undefined,
    }));

    // Pre-select default if available
    const defaultInList = options.find((o) => o.value === DEFAULT_LOCAL_MODEL);
    const initialValue = defaultInList ? DEFAULT_LOCAL_MODEL : options[0]?.value;

    primaryModel = await prompter.select({
      message: "Primary local model (tool calls, lookups)",
      options: [
        ...options,
        { value: "__manual__", label: "Enter manually", hint: "Type provider/model" },
      ],
      initialValue,
    });

    if (primaryModel === "__manual__") {
      primaryModel = await prompter.text({
        message: "Primary model (provider/model)",
        initialValue: DEFAULT_LOCAL_MODEL,
        validate: (v) => (v?.trim().includes("/") ? undefined : "Use provider/model format"),
      });
    }
  } else {
    await prompter.note(
      [
        "No local models detected. Make sure Ollama is running.",
        "Using default: " + DEFAULT_LOCAL_MODEL,
        "",
        "After setup, pull models with: ollama pull <model>",
      ].join("\n"),
      "Local models",
    );
    primaryModel = DEFAULT_LOCAL_MODEL;
  }

  primaryModel = primaryModel?.trim() || DEFAULT_LOCAL_MODEL;

  // 2. Pick fast model
  let fastModel: string | undefined;
  const useDefaultFast = await prompter.confirm({
    message: `Use ${DEFAULT_FAST_MODEL} as fast model for chat?`,
    initialValue: true,
  });

  if (useDefaultFast) {
    fastModel = DEFAULT_FAST_MODEL;
  } else if (localModels.length > 0) {
    const options = localModels
      .filter((m) => modelKey(m.provider, m.id) !== primaryModel)
      .slice(0, 20)
      .map((m) => ({
        value: modelKey(m.provider, m.id),
        label: modelKey(m.provider, m.id),
        hint: m.contextWindow ? `${Math.round(m.contextWindow / 1024)}K ctx` : undefined,
      }));
    if (options.length > 0) {
      fastModel = await prompter.select({
        message: "Fast model for simple chat",
        options: [...options, { value: "__manual__", label: "Enter manually" }],
      });
      if (fastModel === "__manual__") {
        fastModel = await prompter.text({
          message: "Fast model (provider/model)",
          initialValue: DEFAULT_FAST_MODEL,
          validate: (v) => (v?.trim().includes("/") ? undefined : "Use provider/model format"),
        });
      }
    } else {
      fastModel = await prompter.text({
        message: "Fast model (provider/model)",
        initialValue: DEFAULT_FAST_MODEL,
        validate: (v) => (v?.trim().includes("/") ? undefined : "Use provider/model format"),
      });
    }
  } else {
    fastModel = DEFAULT_FAST_MODEL;
  }

  fastModel = fastModel?.trim() || DEFAULT_FAST_MODEL;

  // 3. Apply local config
  config = {
    ...config,
    agents: {
      ...config.agents,
      defaults: {
        ...config.agents?.defaults,
        model: { primary: primaryModel },
        routing: {
          enabled: true,
          fastModel,
          maxSimpleLength: 250,
        },
      },
    },
  };

  // 4. For balanced strategy, also configure orchestrator
  if (strategy === "balanced") {
    const apiModel = await promptApiModel({
      prompter,
      catalog,
      message: "API model for complex tasks (or skip)",
      allowSkip: true,
    });

    if (apiModel) {
      config = {
        ...config,
        agents: {
          ...config.agents,
          defaults: {
            ...config.agents?.defaults,
            orchestrator: {
              enabled: true,
              model: apiModel,
              strategy: "auto",
              maxSimpleLength: 250,
            },
          },
        },
      };
    }
  }

  // 5. Check if default Ollama models need to be pulled
  await ensureOllamaModels({ prompter, models: [primaryModel, fastModel] });

  const lines = [`Primary model: ${primaryModel}`, `Fast model: ${fastModel}`];
  const orch = config.agents?.defaults?.orchestrator;
  if (orch?.enabled && orch.model) {
    lines.push(`API model: ${orch.model} (strategy: ${orch.strategy ?? "auto"})`);
  } else if (strategy === "balanced") {
    lines.push("API model: skipped (local-only for now)");
  }
  await prompter.note(lines.join("\n"), "Strategy applied");

  return config;
}

// ── API model picker ─────────────────────────────────────────────────────────

async function promptApiModel(params: {
  prompter: WizardPrompter;
  catalog: ModelCatalogEntry[];
  message: string;
  allowSkip?: boolean;
}): Promise<string | undefined> {
  const { prompter, catalog, message, allowSkip } = params;

  // Merge catalog API models with well-known list
  const apiCatalogModels = catalog.filter((e) => !isLocalModelProvider(e.provider));
  const wellKnownKeys = new Set(WELL_KNOWN_API_MODELS.map((m) => m.value));
  const extraOptions = apiCatalogModels
    .filter((m) => !wellKnownKeys.has(modelKey(m.provider, m.id)))
    .slice(0, 10)
    .map((m) => ({
      value: modelKey(m.provider, m.id),
      label: modelKey(m.provider, m.id),
      hint: m.contextWindow ? `${Math.round(m.contextWindow / 1024)}K ctx` : undefined,
    }));

  const options = [
    ...(allowSkip
      ? [{ value: "__skip__", label: "Skip (no API model)", hint: "Configure later" }]
      : []),
    ...WELL_KNOWN_API_MODELS.map((m) => ({
      value: m.value,
      label: m.value,
      hint: m.hint,
    })),
    ...extraOptions,
    { value: "__manual__", label: "Enter manually", hint: "Type provider/model" },
  ];

  const selected = await prompter.select({
    message,
    options,
    initialValue: allowSkip ? "__skip__" : options[0]?.value,
  });

  if (selected === "__skip__") {
    return undefined;
  }

  if (selected === "__manual__") {
    const input = await prompter.text({
      message: "API model (provider/model)",
      placeholder: "anthropic/claude-sonnet-4",
      validate: (v) => (v?.trim().includes("/") ? undefined : "Use provider/model format"),
    });
    return input.trim() || undefined;
  }

  return selected;
}

// ── Ollama model auto-download ───────────────────────────────────────────────

async function isOllamaReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_API_BASE}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function isOllamaModelAvailable(modelName: string): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_API_BASE}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: modelName }),
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function pullOllamaModel(
  modelName: string,
  onProgress: (percent: number, status: string) => void,
): Promise<boolean> {
  try {
    const res = await fetch(`${OLLAMA_API_BASE}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: modelName, stream: true }),
      signal: AbortSignal.timeout(600_000), // 10 min timeout for large models
    });

    if (!res.ok || !res.body) {
      return false;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line) as {
            status?: string;
            completed?: number;
            total?: number;
          };
          if (data.total && data.completed) {
            const pct = Math.round((data.completed / data.total) * 100);
            onProgress(pct, data.status ?? "downloading");
          } else if (data.status) {
            onProgress(-1, data.status);
          }
        } catch {
          // ignore malformed lines
        }
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** Check if required Ollama models are available and offer to pull missing ones. */
async function ensureOllamaModels(params: {
  prompter: WizardPrompter;
  models: string[];
}): Promise<void> {
  const { prompter, models } = params;

  // Only check ollama models
  const ollamaModels = models
    .filter((m) => m.startsWith("ollama/"))
    .map((m) => m.replace(/^ollama\//, ""));

  if (ollamaModels.length === 0) return;

  const reachable = await isOllamaReachable();
  if (!reachable) {
    await prompter.note(
      [
        "Ollama is not running. Start it before using local models.",
        "",
        "After starting Ollama, pull your models:",
        ...ollamaModels.map((m) => `  ollama pull ${m}`),
      ].join("\n"),
      "Ollama not detected",
    );
    return;
  }

  // Check which models are missing
  const missing: string[] = [];
  for (const model of ollamaModels) {
    const available = await isOllamaModelAvailable(model);
    if (!available) {
      missing.push(model);
    }
  }

  if (missing.length === 0) return;

  const shouldPull = await prompter.confirm({
    message: `Download ${missing.length} missing Ollama model${missing.length > 1 ? "s" : ""} now? (${missing.join(", ")})`,
    initialValue: true,
  });

  if (!shouldPull) {
    await prompter.note(
      [
        "Skipped model download. Pull them manually before first use:",
        ...missing.map((m) => `  ollama pull ${m}`),
      ].join("\n"),
      "Manual pull needed",
    );
    return;
  }

  for (const model of missing) {
    const progress = createCliProgress({
      label: `Pulling ${model}`,
      indeterminate: true,
    });

    const ok = await pullOllamaModel(model, (pct, status) => {
      if (pct >= 0) {
        progress.setPercent(pct);
        progress.setLabel(`Pulling ${model}: ${status}`);
      } else {
        progress.setLabel(`Pulling ${model}: ${status}`);
      }
    });

    progress.done();

    if (ok) {
      await prompter.note(`${model} downloaded successfully.`, "Model ready");
    } else {
      await prompter.note(
        `Failed to download ${model}. Pull it manually: ollama pull ${model}`,
        "Download failed",
      );
    }
  }
}
