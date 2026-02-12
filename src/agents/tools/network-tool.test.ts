import { describe, expect, it } from "vitest";
import { createNetworkTool } from "./network-tool.js";

describe("network tool", () => {
  const tool = createNetworkTool();

  it("has correct name and schema", () => {
    expect(tool.name).toBe("network");
    expect(tool.parameters).toBeDefined();
  });

  it("lists network interfaces", async () => {
    const result = await tool.execute("call-1", { action: "interfaces" });
    const details = result.details as Record<string, unknown>;
    expect(details.all).toBeDefined();
    expect(Array.isArray(details.all)).toBe(true);
  });

  it("resolves DNS A records", async () => {
    const result = await tool.execute("call-2", {
      action: "dns_lookup",
      host: "localhost",
      recordType: "A",
    });
    const details = result.details as Record<string, unknown>;
    expect(details.host).toBe("localhost");
    // localhost should resolve to 127.0.0.1
    if (!details.error) {
      expect(details.records).toBeDefined();
    }
  });

  it("checks a port", async () => {
    const result = await tool.execute("call-3", {
      action: "port_check",
      host: "127.0.0.1",
      port: 1, // Port 1 is almost certainly closed
      timeout: 2,
    });
    const details = result.details as Record<string, unknown>;
    expect(details.host).toBe("127.0.0.1");
    const results = details.results as Array<Record<string, unknown>>;
    expect(results).toHaveLength(1);
    expect(results[0].port).toBe(1);
  });

  it("checks multiple ports", async () => {
    const result = await tool.execute("call-4", {
      action: "port_check",
      host: "127.0.0.1",
      ports: [1, 2, 3],
      timeout: 2,
    });
    const details = result.details as Record<string, unknown>;
    const results = details.results as Array<Record<string, unknown>>;
    expect(results).toHaveLength(3);
  });

  it("lists connections", async () => {
    const result = await tool.execute("call-5", { action: "connections" });
    const details = result.details as Record<string, unknown>;
    // Should at least not error
    expect(details).toBeDefined();
  });

  it("performs http check", async () => {
    // Check against a non-existent local address to test error handling
    const result = await tool.execute("call-6", {
      action: "http_check",
      url: "http://127.0.0.1:1",
      timeout: 2,
    });
    const details = result.details as Record<string, unknown>;
    expect(details.url).toBe("http://127.0.0.1:1");
    // Should fail gracefully
    expect(details.ok).toBe(false);
  });
});
