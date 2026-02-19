import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  clearOnboardingCheckpoint,
  getOnboardingCheckpoint,
  isStepCompleted,
  normalizeGatewayTokenInput,
  openUrl,
  resolveBrowserOpenCommand,
  resolveControlUiLinks,
  saveOnboardingCheckpoint,
} from "./onboard-helpers.js";

const mocks = vi.hoisted(() => ({
  runCommandWithTimeout: vi.fn(async () => ({
    stdout: "",
    stderr: "",
    code: 0,
    signal: null,
    killed: false,
  })),
  pickPrimaryTailnetIPv4: vi.fn(() => undefined),
}));

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: mocks.runCommandWithTimeout,
}));

vi.mock("../infra/tailnet.js", () => ({
  pickPrimaryTailnetIPv4: mocks.pickPrimaryTailnetIPv4,
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("openUrl", () => {
  it("quotes URLs on win32 so '&' is not treated as cmd separator", async () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "");
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "development");

    const url =
      "https://accounts.google.com/o/oauth2/v2/auth?client_id=abc&response_type=code&redirect_uri=http%3A%2F%2Flocalhost";

    const ok = await openUrl(url);
    expect(ok).toBe(true);

    expect(mocks.runCommandWithTimeout).toHaveBeenCalledTimes(1);
    const [argv, options] = mocks.runCommandWithTimeout.mock.calls[0] ?? [];
    expect(argv?.slice(0, 4)).toEqual(["cmd", "/c", "start", '""']);
    expect(argv?.at(-1)).toBe(`"${url}"`);
    expect(options).toMatchObject({
      timeoutMs: 5_000,
      windowsVerbatimArguments: true,
    });

    platformSpy.mockRestore();
  });
});

describe("resolveBrowserOpenCommand", () => {
  it("marks win32 commands as quoteUrl=true", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const resolved = await resolveBrowserOpenCommand();
    expect(resolved.argv).toEqual(["cmd", "/c", "start", ""]);
    expect(resolved.quoteUrl).toBe(true);
    platformSpy.mockRestore();
  });
});

describe("resolveControlUiLinks", () => {
  it("uses customBindHost for custom bind", () => {
    const links = resolveControlUiLinks({
      port: 18789,
      bind: "custom",
      customBindHost: "192.168.1.100",
    });
    expect(links.httpUrl).toBe("http://192.168.1.100:18789/");
    expect(links.wsUrl).toBe("ws://192.168.1.100:18789");
  });

  it("falls back to loopback for invalid customBindHost", () => {
    const links = resolveControlUiLinks({
      port: 18789,
      bind: "custom",
      customBindHost: "192.168.001.100",
    });
    expect(links.httpUrl).toBe("http://127.0.0.1:18789/");
    expect(links.wsUrl).toBe("ws://127.0.0.1:18789");
  });

  it("uses tailnet IP for tailnet bind", () => {
    mocks.pickPrimaryTailnetIPv4.mockReturnValueOnce("100.64.0.9");
    const links = resolveControlUiLinks({
      port: 18789,
      bind: "tailnet",
    });
    expect(links.httpUrl).toBe("http://100.64.0.9:18789/");
    expect(links.wsUrl).toBe("ws://100.64.0.9:18789");
  });

  it("keeps loopback for auto even when tailnet is present", () => {
    mocks.pickPrimaryTailnetIPv4.mockReturnValueOnce("100.64.0.9");
    const links = resolveControlUiLinks({
      port: 18789,
      bind: "auto",
    });
    expect(links.httpUrl).toBe("http://127.0.0.1:18789/");
    expect(links.wsUrl).toBe("ws://127.0.0.1:18789");
  });
});

describe("normalizeGatewayTokenInput", () => {
  it("returns empty string for undefined or null", () => {
    expect(normalizeGatewayTokenInput(undefined)).toBe("");
    expect(normalizeGatewayTokenInput(null)).toBe("");
  });

  it("trims string input", () => {
    expect(normalizeGatewayTokenInput("  token  ")).toBe("token");
  });

  it("returns empty string for non-string input", () => {
    expect(normalizeGatewayTokenInput(123)).toBe("");
  });
});

describe("saveOnboardingCheckpoint", () => {
  it("saves a checkpoint into wizard metadata", () => {
    const cfg: OpenClawConfig = {};
    const result = saveOnboardingCheckpoint(cfg, "model-strategy", "quickstart");
    expect(result.wizard?.onboardingCheckpoint).toMatchObject({
      step: "model-strategy",
      flow: "quickstart",
    });
    expect(result.wizard?.onboardingCheckpoint?.startedAt).toBeTruthy();
  });

  it("preserves existing startedAt on subsequent saves", () => {
    const cfg: OpenClawConfig = {
      wizard: {
        onboardingCheckpoint: {
          step: "auth",
          startedAt: "2025-01-01T00:00:00.000Z",
          flow: "quickstart",
        },
      },
    };
    const result = saveOnboardingCheckpoint(cfg, "gateway", "quickstart");
    expect(result.wizard?.onboardingCheckpoint?.startedAt).toBe("2025-01-01T00:00:00.000Z");
    expect(result.wizard?.onboardingCheckpoint?.step).toBe("gateway");
  });

  it("preserves other wizard metadata", () => {
    const cfg: OpenClawConfig = {
      wizard: { lastRunAt: "2025-01-01T00:00:00.000Z", lastRunCommand: "onboard" },
    };
    const result = saveOnboardingCheckpoint(cfg, "auth");
    expect(result.wizard?.lastRunAt).toBe("2025-01-01T00:00:00.000Z");
    expect(result.wizard?.lastRunCommand).toBe("onboard");
  });
});

describe("clearOnboardingCheckpoint", () => {
  it("removes the checkpoint from wizard metadata", () => {
    const cfg: OpenClawConfig = {
      wizard: {
        lastRunAt: "2025-01-01T00:00:00.000Z",
        onboardingCheckpoint: {
          step: "gateway",
          startedAt: "2025-01-01T00:00:00.000Z",
        },
      },
    };
    const result = clearOnboardingCheckpoint(cfg);
    expect(result.wizard?.onboardingCheckpoint).toBeUndefined();
    expect(result.wizard?.lastRunAt).toBe("2025-01-01T00:00:00.000Z");
  });

  it("returns config unchanged when no checkpoint exists", () => {
    const cfg: OpenClawConfig = { wizard: { lastRunAt: "2025-01-01T00:00:00.000Z" } };
    const result = clearOnboardingCheckpoint(cfg);
    expect(result).toBe(cfg);
  });

  it("returns config unchanged when wizard is undefined", () => {
    const cfg: OpenClawConfig = {};
    const result = clearOnboardingCheckpoint(cfg);
    expect(result).toBe(cfg);
  });
});

describe("getOnboardingCheckpoint", () => {
  it("returns the checkpoint when present", () => {
    const cfg: OpenClawConfig = {
      wizard: {
        onboardingCheckpoint: {
          step: "channels",
          startedAt: "2025-01-01T00:00:00.000Z",
          flow: "advanced",
        },
      },
    };
    const cp = getOnboardingCheckpoint(cfg);
    expect(cp).toEqual({
      step: "channels",
      startedAt: "2025-01-01T00:00:00.000Z",
      flow: "advanced",
    });
  });

  it("returns undefined when no checkpoint exists", () => {
    expect(getOnboardingCheckpoint({})).toBeUndefined();
    expect(getOnboardingCheckpoint({ wizard: {} })).toBeUndefined();
  });

  it("returns undefined for unknown step names", () => {
    const cfg: OpenClawConfig = {
      wizard: {
        onboardingCheckpoint: {
          step: "nonexistent-step",
          startedAt: "2025-01-01T00:00:00.000Z",
        },
      },
    };
    expect(getOnboardingCheckpoint(cfg)).toBeUndefined();
  });
});

describe("isStepCompleted", () => {
  it("auth is completed when checkpoint is model-strategy", () => {
    expect(isStepCompleted("model-strategy", "auth")).toBe(true);
  });

  it("model-strategy is NOT completed when checkpoint is model-strategy (same step)", () => {
    expect(isStepCompleted("model-strategy", "model-strategy")).toBe(false);
  });

  it("gateway is NOT completed when checkpoint is model-strategy", () => {
    expect(isStepCompleted("model-strategy", "gateway")).toBe(false);
  });

  it("all steps before complete are completed when checkpoint is complete", () => {
    expect(isStepCompleted("complete", "auth")).toBe(true);
    expect(isStepCompleted("complete", "model-strategy")).toBe(true);
    expect(isStepCompleted("complete", "gateway")).toBe(true);
    expect(isStepCompleted("complete", "channels")).toBe(true);
    expect(isStepCompleted("complete", "skills")).toBe(true);
    expect(isStepCompleted("complete", "hooks")).toBe(true);
  });

  it("no steps are completed when checkpoint is auth (first step)", () => {
    expect(isStepCompleted("auth", "auth")).toBe(false);
    expect(isStepCompleted("auth", "model-strategy")).toBe(false);
    expect(isStepCompleted("auth", "gateway")).toBe(false);
  });
});
