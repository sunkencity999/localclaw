import chalk from "chalk";

type Log = {
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
};

const OLLAMA_API_BASE = "http://127.0.0.1:11434";

/**
 * Keep-alive duration sent to Ollama when pre-warming the model.
 * Keeps the model loaded in memory between requests so the agent avoids
 * costly cold-start reloads (10–16 s for large models).
 */
const OLLAMA_KEEP_ALIVE = "24h";

/**
 * Pre-warm an Ollama model so the first real agent request is fast.
 *
 * Sends a minimal /api/generate request with:
 * - `keep_alive` set high so the model stays resident in memory
 * - `num_predict: 1` to minimise work — we only care about loading the model
 *
 * The model's full context window is preserved (no num_ctx override) because
 * agents need large context for tool schemas, conversation history, and
 * multi-step reasoning chains.
 *
 * Also checks whether flash attention is enabled and logs a recommendation
 * if it is not.
 */
export async function warmUpOllamaModel(params: { model: string; log: Log }): Promise<void> {
  const { model, log } = params;

  try {
    const res = await fetch(`${OLLAMA_API_BASE}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt: " ",
        stream: false,
        keep_alive: OLLAMA_KEEP_ALIVE,
        options: {
          num_predict: 1,
        },
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) {
      log.warn(`ollama warm-up: failed to pre-load model (HTTP ${res.status})`, {
        consoleMessage: `${chalk.yellow("⚠")} Ollama warm-up failed (HTTP ${res.status})`,
      });
      return;
    }

    const data = (await res.json()) as { load_duration?: number };
    const loadMs = Math.round((data.load_duration ?? 0) / 1e6);

    log.info(
      `ollama warm-up: model "${model}" pre-loaded (keep_alive=${OLLAMA_KEEP_ALIVE}, load=${loadMs}ms)`,
      {
        consoleMessage: `${chalk.green("✓")} Ollama model pre-warmed ${chalk.dim(`(keep_alive=${OLLAMA_KEEP_ALIVE}, load=${loadMs}ms)`)}`,
      },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`ollama warm-up: ${msg}`, {
      consoleMessage: `${chalk.yellow("⚠")} Ollama warm-up: ${chalk.dim(msg)}`,
    });
  }

  checkFlashAttention(log);
}

/**
 * Check if OLLAMA_FLASH_ATTENTION is enabled and log a recommendation if not.
 * Flash attention significantly reduces memory usage and improves throughput
 * for long-context workloads on supported hardware.
 */
function checkFlashAttention(log: Log): void {
  const flashAttn = process.env.OLLAMA_FLASH_ATTENTION;
  if (flashAttn === "1" || flashAttn === "true") {
    return;
  }

  log.warn(
    "ollama: flash attention is not enabled — set OLLAMA_FLASH_ATTENTION=1 for better performance",
    {
      consoleMessage: `${chalk.yellow("⚠")} Ollama: ${chalk.dim("set")} OLLAMA_FLASH_ATTENTION=1 ${chalk.dim("for better performance (add to ~/.zshrc or ~/.bashrc)")}`,
    },
  );
}
