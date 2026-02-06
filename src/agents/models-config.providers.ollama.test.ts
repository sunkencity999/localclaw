import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveImplicitProviders } from "./models-config.providers.js";

describe("Ollama provider", () => {
  it("should not include ollama when no API key is configured", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));
    const providers = await resolveImplicitProviders({ agentDir });

    // Ollama requires explicit configuration via OLLAMA_API_KEY env var or profile
    expect(providers?.ollama).toBeUndefined();
  });

  it("auto-detects ollama when local discovery is enabled and server responds", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-test-"));

    const prev = process.env.OPENCLAW_TEST_ENABLE_LOCAL_DISCOVERY;
    process.env.OPENCLAW_TEST_ENABLE_LOCAL_DISCOVERY = "1";

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url =
        input instanceof URL
          ? input.toString()
          : typeof input === "string"
            ? input
            : input instanceof Request
              ? input.url
              : String(input);
      if (url.endsWith("/api/tags")) {
        return new Response(
          JSON.stringify({
            models: [
              {
                name: "llama3.2:3b",
                modified_at: "2026-01-01T00:00:00Z",
                size: 1,
                digest: "test",
                details: { family: "llama", parameter_size: "3B" },
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({}), { status: 404 });
    }) as typeof fetch;

    try {
      const providers = await resolveImplicitProviders({ agentDir });
      expect(providers?.ollama).toBeTruthy();
    } finally {
      globalThis.fetch = originalFetch;
      if (prev === undefined) {
        delete process.env.OPENCLAW_TEST_ENABLE_LOCAL_DISCOVERY;
      } else {
        process.env.OPENCLAW_TEST_ENABLE_LOCAL_DISCOVERY = prev;
      }
    }
  });
});
