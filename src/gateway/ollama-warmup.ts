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
 * Minimum context window (tokens) required for agent tool calling.
 *
 * Agents need ~7K tokens for the system prompt, ~15K for tool schemas, and
 * headroom for conversation history, so 32768 is a practical minimum.
 *
 * Ollama's OpenAI-compatible endpoint (/v1/chat/completions) always uses the
 * model's Modelfile default num_ctx — per-request overrides are ignored.
 * If the model's default is below this threshold, we update the Modelfile
 * parameters via /api/create so all endpoints use the right context window.
 */
const OLLAMA_MIN_NUM_CTX = 131_072;

/**
 * Pre-warm an Ollama model so the first real agent request is fast.
 *
 * 1. Checks the model's default num_ctx via /api/show.
 * 2. If num_ctx is below OLLAMA_MIN_NUM_CTX, updates the model's Modelfile
 *    parameters via /api/create (non-destructive — same weights, just params).
 * 3. Sends a minimal /api/generate request with keep_alive set high to
 *    keep the model resident in memory.
 *
 * Also checks whether flash attention is enabled and logs a recommendation
 * if it is not.
 */
export async function warmUpOllamaModel(params: { model: string; log: Log }): Promise<void> {
  const { model, log } = params;

  try {
    await ensureMinNumCtx({ model, log });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`ollama warm-up: failed to check/update num_ctx: ${msg}`);
  }

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
 * Ensure the model's default num_ctx is at least OLLAMA_MIN_NUM_CTX.
 *
 * Ollama's /v1/chat/completions endpoint ignores per-request num_ctx overrides
 * and always uses the Modelfile default.  If the default is too small for the
 * agent's system prompt + tool schemas, we update it via /api/create.
 */
async function ensureMinNumCtx(params: { model: string; log: Log }): Promise<void> {
  const { model, log } = params;
  const showRes = await fetch(`${OLLAMA_API_BASE}/api/show`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: model }),
    signal: AbortSignal.timeout(5000),
  });
  if (!showRes.ok) return;

  const showData = (await showRes.json()) as { parameters?: string };
  const currentNumCtx = parseNumCtx(showData.parameters);

  if (currentNumCtx != null && currentNumCtx >= OLLAMA_MIN_NUM_CTX) {
    log.info(`ollama warm-up: model num_ctx=${currentNumCtx} (≥${OLLAMA_MIN_NUM_CTX}, ok)`);
    return;
  }

  log.info(
    `ollama warm-up: model num_ctx=${currentNumCtx ?? "unknown"} < ${OLLAMA_MIN_NUM_CTX}, updating model parameters`,
    {
      consoleMessage: `${chalk.cyan("⟳")} Updating Ollama model num_ctx ${chalk.dim(`${currentNumCtx ?? "?"} → ${OLLAMA_MIN_NUM_CTX}`)}`,
    },
  );

  // Ollama 0.16+ uses `from` + `parameters` instead of the legacy `modelfile` string.
  const createRes = await fetch(`${OLLAMA_API_BASE}/api/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      from: model,
      parameters: { num_ctx: OLLAMA_MIN_NUM_CTX },
      stream: false,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!createRes.ok) {
    const body = await createRes.text().catch(() => "");
    log.warn(`ollama warm-up: failed to update num_ctx (HTTP ${createRes.status}): ${body}`);
    return;
  }

  // Consume response body
  await createRes.text();

  log.info(`ollama warm-up: model num_ctx updated to ${OLLAMA_MIN_NUM_CTX}`, {
    consoleMessage: `${chalk.green("✓")} Ollama model num_ctx updated to ${OLLAMA_MIN_NUM_CTX}`,
  });
}

/** Parse num_ctx from Ollama's /api/show parameters string. */
function parseNumCtx(parameters: string | undefined): number | null {
  if (!parameters) return null;
  const match = /num_ctx\s+(\d+)/.exec(parameters);
  return match ? Number(match[1]) : null;
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
