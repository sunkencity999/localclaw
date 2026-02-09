import chalk from "chalk";
import type { loadConfig } from "../config/config.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { resolveConfiguredModelRef } from "../agents/model-selection.js";

type Log = {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
};

/** Known local provider base URLs (native API, not OpenAI-compat). */
const LOCAL_PROVIDERS: Record<string, { apiBase: string; displayName: string }> = {
  ollama: { apiBase: "http://127.0.0.1:11434", displayName: "Ollama" },
  lmstudio: { apiBase: "http://127.0.0.1:1234", displayName: "LM Studio" },
  vllm: { apiBase: "http://127.0.0.1:8000", displayName: "vLLM" },
};

interface HealthCheckResult {
  provider: string;
  model: string;
  serverReachable: boolean | null;
  modelAvailable: boolean | null;
  contextWindow: number | null;
  warnings: string[];
}

async function checkServerReachable(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    // Fall back to OpenAI-compat /v1/models for LM Studio / vLLM
    try {
      const res = await fetch(`${baseUrl}/v1/models`, {
        signal: AbortSignal.timeout(3000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

async function checkOllamaModel(
  apiBase: string,
  modelName: string,
): Promise<{ available: boolean; contextWindow: number | null }> {
  try {
    const res = await fetch(`${apiBase}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: modelName }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      return { available: false, contextWindow: null };
    }
    const data = (await res.json()) as { model_info?: Record<string, unknown> };
    let contextWindow: number | null = null;
    if (data.model_info) {
      for (const [key, value] of Object.entries(data.model_info)) {
        if (key.endsWith(".context_length") && typeof value === "number" && value > 0) {
          contextWindow = value;
          break;
        }
      }
    }
    return { available: true, contextWindow };
  } catch {
    return { available: false, contextWindow: null };
  }
}

async function checkOpenAiCompatModel(
  baseUrl: string,
  modelName: string,
): Promise<{ available: boolean; contextWindow: number | null }> {
  try {
    const res = await fetch(`${baseUrl}/v1/models`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      return { available: false, contextWindow: null };
    }
    const data = (await res.json()) as { data?: Array<{ id: string }> };
    const models = data.data ?? [];
    const found = models.some(
      (m) => m.id === modelName || m.id.toLowerCase() === modelName.toLowerCase(),
    );
    return { available: found, contextWindow: null };
  } catch {
    return { available: false, contextWindow: null };
  }
}

export async function runStartupHealthCheck(params: {
  cfg: ReturnType<typeof loadConfig>;
  log: Log;
}): Promise<HealthCheckResult> {
  const { provider, model } = resolveConfiguredModelRef({
    cfg: params.cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });

  const result: HealthCheckResult = {
    provider,
    model,
    serverReachable: null,
    modelAvailable: null,
    contextWindow: null,
    warnings: [],
  };

  const localProvider = LOCAL_PROVIDERS[provider.toLowerCase()];
  if (!localProvider) {
    // Cloud provider — skip connectivity checks, just report the model
    params.log.info(`model provider: ${provider} (cloud)`, {
      consoleMessage: `model provider: ${chalk.cyan(provider)} ${chalk.dim("(cloud — skipping connectivity check)")}`,
    });
    return result;
  }

  // Local provider — run health checks
  const { apiBase, displayName } = localProvider;

  // 1. Check server reachability
  const reachable = await checkServerReachable(apiBase);
  result.serverReachable = reachable;

  if (!reachable) {
    const warning = `${displayName} server not reachable at ${apiBase}`;
    result.warnings.push(warning);
    params.log.warn(`health: ${warning}`, {
      consoleMessage: `${chalk.red("✗")} ${chalk.yellow(displayName)} server not reachable at ${chalk.dim(apiBase)}`,
    });
    params.log.warn(
      `health: start ${displayName} and restart the gateway, or change your model config`,
      {
        consoleMessage: `  ${chalk.dim(`→ start ${displayName} and restart the gateway, or change your model config`)}`,
      },
    );
    return result;
  }

  params.log.info(`health: ${displayName} server reachable`, {
    consoleMessage: `${chalk.green("✓")} ${chalk.cyan(displayName)} server reachable at ${chalk.dim(apiBase)}`,
  });

  // 2. Check model availability
  let modelCheck: { available: boolean; contextWindow: number | null };
  if (provider.toLowerCase() === "ollama") {
    modelCheck = await checkOllamaModel(apiBase, model);
  } else {
    modelCheck = await checkOpenAiCompatModel(apiBase, model);
  }

  result.modelAvailable = modelCheck.available;
  result.contextWindow = modelCheck.contextWindow;

  if (!modelCheck.available) {
    const warning = `model "${model}" not found on ${displayName}`;
    result.warnings.push(warning);
    params.log.warn(`health: ${warning}`, {
      consoleMessage: `${chalk.red("✗")} model ${chalk.yellow(model)} not found on ${displayName}`,
    });
    if (provider.toLowerCase() === "ollama") {
      params.log.warn(`health: pull it with: ollama pull ${model}`, {
        consoleMessage: `  ${chalk.dim(`→ pull it with: ollama pull ${model}`)}`,
      });
    }
    return result;
  }

  // 3. Report success with context window
  const ctxStr = modelCheck.contextWindow
    ? ` ${chalk.dim(`(context: ${(modelCheck.contextWindow / 1024).toFixed(0)}K tokens)`)}`
    : "";
  params.log.info(
    `health: model "${model}" available${modelCheck.contextWindow ? ` (context: ${modelCheck.contextWindow} tokens)` : ""}`,
    {
      consoleMessage: `${chalk.green("✓")} model ${chalk.whiteBright(model)} available${ctxStr}`,
    },
  );

  return result;
}
