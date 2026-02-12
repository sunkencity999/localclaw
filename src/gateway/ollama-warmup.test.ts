import { describe, expect, it, vi } from "vitest";
import { warmUpOllamaModel } from "./ollama-warmup.js";

describe("ollama-warmup", () => {
  it("warmUpOllamaModel is a function", () => {
    expect(typeof warmUpOllamaModel).toBe("function");
  });

  it("handles unreachable Ollama gracefully", async () => {
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
    };
    // Mock fetch to simulate unreachable server
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error("Connection refused")) as unknown as typeof fetch;
    try {
      await warmUpOllamaModel({ model: "test-model", log });
      // Should not throw — just logs a warning
      expect(log.warn).toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("logs flash attention recommendation when env var is not set", async () => {
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
    };
    const originalFetch = globalThis.fetch;
    const originalEnv = process.env.OLLAMA_FLASH_ATTENTION;
    delete process.env.OLLAMA_FLASH_ATTENTION;
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error("Connection refused")) as unknown as typeof fetch;
    try {
      await warmUpOllamaModel({ model: "test-model", log });
      const flashWarn = log.warn.mock.calls.find(
        (c: unknown[]) => typeof c[0] === "string" && c[0].includes("flash attention"),
      );
      expect(flashWarn).toBeDefined();
    } finally {
      globalThis.fetch = originalFetch;
      if (originalEnv !== undefined) {
        process.env.OLLAMA_FLASH_ATTENTION = originalEnv;
      }
    }
  });
});
