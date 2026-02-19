import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  agentCliCommand: vi.fn(),
  resolveDefaultAgentId: vi.fn(),
  loadConfig: vi.fn(),
  setVerbose: vi.fn(),
  runCommandWithRuntime: vi.fn(),
  createDefaultDeps: vi.fn(),
  agentsAddCommand: vi.fn(),
  agentsDeleteCommand: vi.fn(),
  agentsListCommand: vi.fn(),
  agentsSetIdentityCommand: vi.fn(),
}));

vi.mock("../../commands/agent-via-gateway.js", () => ({
  agentCliCommand: mocks.agentCliCommand,
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveDefaultAgentId: mocks.resolveDefaultAgentId,
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: mocks.loadConfig,
}));

vi.mock("../../globals.js", () => ({
  setVerbose: mocks.setVerbose,
}));

vi.mock("../cli-utils.js", () => ({
  runCommandWithRuntime: mocks.runCommandWithRuntime,
}));

vi.mock("../deps.js", () => ({
  createDefaultDeps: mocks.createDefaultDeps,
}));

vi.mock("../../commands/agents.js", () => ({
  agentsAddCommand: mocks.agentsAddCommand,
  agentsDeleteCommand: mocks.agentsDeleteCommand,
  agentsListCommand: mocks.agentsListCommand,
  agentsSetIdentityCommand: mocks.agentsSetIdentityCommand,
}));

const { registerAgentCommands } = await import("./register.agent.js");

describe("registerAgentCommands ask", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadConfig.mockReturnValue({ agents: { list: [{ id: "main", default: true }] } });
    mocks.resolveDefaultAgentId.mockReturnValue("main");
    mocks.createDefaultDeps.mockReturnValue({});
    mocks.runCommandWithRuntime.mockImplementation(async (_runtime, fn: () => Promise<void>) => {
      await fn();
    });
  });

  it("routes ask to agentCliCommand using the default agent", async () => {
    const program = new Command();
    registerAgentCommands(program, { agentChannelOptions: "whatsapp|telegram" });

    await program.parseAsync(["node", "openclaw", "ask", "hello", "world"]);

    expect(mocks.resolveDefaultAgentId).toHaveBeenCalledTimes(1);
    expect(mocks.agentCliCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "hello world",
        agent: "main",
      }),
      expect.any(Object),
      {},
    );
    expect(mocks.setVerbose).toHaveBeenCalledWith(false);
  });

  it("keeps explicit ask options when provided", async () => {
    const program = new Command();
    registerAgentCommands(program, { agentChannelOptions: "whatsapp|telegram" });

    await program.parseAsync([
      "node",
      "openclaw",
      "ask",
      "--agent",
      "ops",
      "--thinking",
      "medium",
      "--verbose",
      "on",
      "--local",
      "--json",
      "--timeout",
      "42",
      "ping",
    ]);

    expect(mocks.agentCliCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "ping",
        agent: "ops",
        thinking: "medium",
        verbose: "on",
        local: true,
        json: true,
        timeout: "42",
      }),
      expect.any(Object),
      {},
    );
    expect(mocks.setVerbose).toHaveBeenCalledWith(true);
  });
});
