import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CLI_NAME } from "./cli-name.js";
import { formatCliCommand } from "./command-format.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "./profile.js";

const CLI = DEFAULT_CLI_NAME;

describe("parseCliProfileArgs", () => {
  it("leaves gateway --dev for subcommands", () => {
    const res = parseCliProfileArgs([
      "node",
      "openclaw",
      "gateway",
      "--dev",
      "--allow-unconfigured",
    ]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBeNull();
    expect(res.argv).toEqual(["node", "openclaw", "gateway", "--dev", "--allow-unconfigured"]);
  });

  it("still accepts global --dev before subcommand", () => {
    const res = parseCliProfileArgs(["node", "openclaw", "--dev", "gateway"]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBe("dev");
    expect(res.argv).toEqual(["node", "openclaw", "gateway"]);
  });

  it("parses --profile value and strips it", () => {
    const res = parseCliProfileArgs(["node", "openclaw", "--profile", "work", "status"]);
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.profile).toBe("work");
    expect(res.argv).toEqual(["node", "openclaw", "status"]);
  });

  it("rejects missing profile value", () => {
    const res = parseCliProfileArgs(["node", "openclaw", "--profile"]);
    expect(res.ok).toBe(false);
  });

  it("rejects combining --dev with --profile (dev first)", () => {
    const res = parseCliProfileArgs(["node", "openclaw", "--dev", "--profile", "work", "status"]);
    expect(res.ok).toBe(false);
  });

  it("rejects combining --dev with --profile (profile first)", () => {
    const res = parseCliProfileArgs(["node", "openclaw", "--profile", "work", "--dev", "status"]);
    expect(res.ok).toBe(false);
  });
});

describe("applyCliProfileEnv", () => {
  it("fills env defaults for dev profile", () => {
    const env: Record<string, string | undefined> = {};
    applyCliProfileEnv({
      profile: "dev",
      env,
      homedir: () => "/home/peter",
    });
    const expectedStateDir = path.join("/home/peter", ".openclaw-dev");
    expect(env.OPENCLAW_PROFILE).toBe("dev");
    expect(env.OPENCLAW_STATE_DIR).toBe(expectedStateDir);
    expect(env.OPENCLAW_CONFIG_PATH).toBe(path.join(expectedStateDir, "openclaw.json"));
    expect(env.OPENCLAW_GATEWAY_PORT).toBe("19001");
  });

  it("does not override explicit env values", () => {
    const env: Record<string, string | undefined> = {
      OPENCLAW_STATE_DIR: "/custom",
      OPENCLAW_GATEWAY_PORT: "19099",
    };
    applyCliProfileEnv({
      profile: "dev",
      env,
      homedir: () => "/home/peter",
    });
    expect(env.OPENCLAW_STATE_DIR).toBe("/custom");
    expect(env.OPENCLAW_GATEWAY_PORT).toBe("19099");
    expect(env.OPENCLAW_CONFIG_PATH).toBe(path.join("/custom", "openclaw.json"));
  });
});

describe("formatCliCommand", () => {
  it("returns command unchanged when no profile is set", () => {
    expect(formatCliCommand("openclaw doctor --fix", {})).toBe(`${CLI} doctor --fix`);
  });

  it("returns command unchanged when profile is default", () => {
    expect(formatCliCommand("openclaw doctor --fix", { OPENCLAW_PROFILE: "default" })).toBe(
      `${CLI} doctor --fix`,
    );
  });

  it("returns command unchanged when profile is Default (case-insensitive)", () => {
    expect(formatCliCommand("openclaw doctor --fix", { OPENCLAW_PROFILE: "Default" })).toBe(
      `${CLI} doctor --fix`,
    );
  });

  it("returns command unchanged when profile is invalid", () => {
    expect(formatCliCommand("openclaw doctor --fix", { OPENCLAW_PROFILE: "bad profile" })).toBe(
      `${CLI} doctor --fix`,
    );
  });

  it("returns command unchanged when --profile is already present", () => {
    expect(
      formatCliCommand("openclaw --profile work doctor --fix", { OPENCLAW_PROFILE: "work" }),
    ).toBe(`${CLI} --profile work doctor --fix`);
  });

  it("returns command unchanged when --dev is already present", () => {
    expect(formatCliCommand("openclaw --dev doctor", { OPENCLAW_PROFILE: "dev" })).toBe(
      `${CLI} --dev doctor`,
    );
  });

  it("inserts --profile flag when profile is set", () => {
    expect(formatCliCommand("openclaw doctor --fix", { OPENCLAW_PROFILE: "work" })).toBe(
      `${CLI} --profile work doctor --fix`,
    );
  });

  it("trims whitespace from profile", () => {
    expect(formatCliCommand("openclaw doctor --fix", { OPENCLAW_PROFILE: "  jbopenclaw  " })).toBe(
      `${CLI} --profile jbopenclaw doctor --fix`,
    );
  });

  it("handles command with no args after openclaw", () => {
    expect(formatCliCommand("openclaw", { OPENCLAW_PROFILE: "test" })).toBe(
      `${CLI} --profile test`,
    );
  });

  it("handles pnpm wrapper", () => {
    expect(formatCliCommand("pnpm openclaw doctor", { OPENCLAW_PROFILE: "work" })).toBe(
      `pnpm ${CLI} --profile work doctor`,
    );
  });
});
