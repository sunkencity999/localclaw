import { describe, expect, it } from "vitest";
import { createResourceMonitorTool } from "./resource-monitor-tool.js";

describe("resource_monitor tool", () => {
  const tool = createResourceMonitorTool();

  it("has correct name and schema", () => {
    expect(tool.name).toBe("resource_monitor");
    expect(tool.parameters).toBeDefined();
  });

  it("returns a full snapshot by default", async () => {
    const result = await tool.execute("call-1", {});
    expect(result.content).toBeDefined();
    expect(result.details).toBeDefined();

    const details = result.details as Record<string, unknown>;
    expect(details.platform).toBeDefined();
    expect(details.cpu).toBeDefined();
    expect(details.memory).toBeDefined();
    expect(details.gpu).toBeDefined();
    expect(details.disk).toBeDefined();
    expect(details.processes).toBeDefined();

    const cpu = details.cpu as Record<string, unknown>;
    expect(cpu.cores).toBeGreaterThan(0);
    expect(cpu.logicalCores).toBeGreaterThan(0);
    expect(typeof cpu.usagePercent).toBe("number");

    const memory = details.memory as Record<string, unknown>;
    expect(memory.totalMb).toBeGreaterThan(0);
    expect(typeof memory.usagePercent).toBe("number");
  });

  it("returns cpu info", async () => {
    const result = await tool.execute("call-2", { action: "cpu" });
    const details = result.details as Record<string, unknown>;
    expect(details.cpu).toBeDefined();
    const cpu = details.cpu as Record<string, unknown>;
    expect(cpu.model).toBeDefined();
    expect(cpu.loadAverage).toHaveLength(3);
  });

  it("returns memory info", async () => {
    const result = await tool.execute("call-3", { action: "memory" });
    const details = result.details as Record<string, unknown>;
    expect(details.memory).toBeDefined();
    const mem = details.memory as Record<string, unknown>;
    expect(mem.totalMb).toBeGreaterThan(0);
    expect(mem.freeMb).toBeGreaterThan(0);
  });

  it("returns gpu info (may be empty)", async () => {
    const result = await tool.execute("call-4", { action: "gpu" });
    const details = result.details as Record<string, unknown>;
    expect(Array.isArray(details.gpu)).toBe(true);
  });

  it("returns disk info", async () => {
    const result = await tool.execute("call-5", { action: "disk" });
    const details = result.details as Record<string, unknown>;
    expect(Array.isArray(details.disk)).toBe(true);
    const disks = details.disk as Array<Record<string, unknown>>;
    expect(disks.length).toBeGreaterThan(0);
    expect(disks[0].mount).toBeDefined();
  });

  it("returns top processes", async () => {
    const result = await tool.execute("call-6", { action: "processes", topN: 5 });
    const details = result.details as Record<string, unknown>;
    expect(Array.isArray(details.processes)).toBe(true);
    const procs = details.processes as Array<Record<string, unknown>>;
    expect(procs.length).toBeLessThanOrEqual(5);
    if (procs.length > 0) {
      expect(procs[0].pid).toBeDefined();
      expect(procs[0].name).toBeDefined();
    }
  });

  it("defaults to snapshot when action is omitted", async () => {
    const result = await tool.execute("call-7", undefined);
    const details = result.details as Record<string, unknown>;
    expect(details.cpu).toBeDefined();
    expect(details.memory).toBeDefined();
  });
});
