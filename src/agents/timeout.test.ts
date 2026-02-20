import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveLocalModelTimeoutMs,
  LOCAL_WITH_API_FALLBACK_TIMEOUT_SECONDS,
  LOCAL_ONLY_TIMEOUT_SECONDS,
} from "./timeout.js";

describe("resolveLocalModelTimeoutMs", () => {
  it("returns shorter timeout when API fallback is available", () => {
    const ms = resolveLocalModelTimeoutMs({ hasApiFallback: true });
    expect(ms).toBe(LOCAL_WITH_API_FALLBACK_TIMEOUT_SECONDS * 1000);
    expect(ms).toBe(240_000);
  });

  it("returns longer timeout for local-only setups", () => {
    const ms = resolveLocalModelTimeoutMs({ hasApiFallback: false });
    expect(ms).toBe(LOCAL_ONLY_TIMEOUT_SECONDS * 1000);
    expect(ms).toBe(600_000);
  });

  it("respects explicit user override regardless of fallback", () => {
    const cfg = {
      agents: { defaults: { timeoutSeconds: 120 } },
    } as unknown as OpenClawConfig;
    expect(resolveLocalModelTimeoutMs({ cfg, hasApiFallback: true })).toBe(120_000);
    expect(resolveLocalModelTimeoutMs({ cfg, hasApiFallback: false })).toBe(120_000);
  });

  it("enforces minimum 1s for explicit override", () => {
    const cfg = {
      agents: { defaults: { timeoutSeconds: 0 } },
    } as unknown as OpenClawConfig;
    expect(resolveLocalModelTimeoutMs({ cfg, hasApiFallback: true })).toBe(1000);
  });
});
