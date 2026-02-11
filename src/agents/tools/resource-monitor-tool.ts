import { Type } from "@sinclair/typebox";
import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";
import { optionalStringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult } from "./common.js";

const execFileAsync = promisify(execFile);

const RESOURCE_ACTIONS = ["snapshot", "cpu", "memory", "gpu", "disk", "processes"] as const;

const ResourceMonitorSchema = Type.Object({
  action: optionalStringEnum(RESOURCE_ACTIONS),
  topN: Type.Optional(
    Type.Number({ description: "Number of top processes to return (default 10)" }),
  ),
});

type CpuSnapshot = {
  model: string;
  cores: number;
  logicalCores: number;
  loadAverage: [number, number, number];
  usagePercent: number;
};

type MemorySnapshot = {
  totalMb: number;
  usedMb: number;
  freeMb: number;
  usagePercent: number;
  swapTotalMb: number;
  swapUsedMb: number;
};

type GpuInfo = {
  name: string;
  memoryTotalMb?: number;
  memoryUsedMb?: number;
  memoryFreeMb?: number;
  utilizationPercent?: number;
  temperatureC?: number;
};

type DiskInfo = {
  filesystem: string;
  mount: string;
  sizeMb: number;
  usedMb: number;
  availableMb: number;
  usagePercent: number;
};

type ProcessInfo = {
  pid: number;
  name: string;
  cpuPercent: number;
  memoryMb: number;
};

function getCpuSnapshot(): CpuSnapshot {
  const cpus = os.cpus();
  const model = cpus[0]?.model ?? "unknown";
  const logicalCores = cpus.length;
  // Physical cores: on macOS/Linux the logical count is what we have;
  // a rough heuristic is logical / 2 for hyper-threaded, but we report both.
  const cores = Math.max(1, Math.ceil(logicalCores / 2));
  const loadAverage = os.loadavg() as [number, number, number];

  // Calculate CPU usage from idle vs total across all cores
  let totalIdle = 0;
  let totalTick = 0;
  for (const cpu of cpus) {
    const { user, nice, sys, idle, irq } = cpu.times;
    totalIdle += idle;
    totalTick += user + nice + sys + idle + irq;
  }
  const usagePercent =
    totalTick > 0 ? Math.round(((totalTick - totalIdle) / totalTick) * 1000) / 10 : 0;

  return { model, cores, logicalCores, loadAverage, usagePercent };
}

function getMemorySnapshot(): MemorySnapshot {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const usedBytes = totalBytes - freeBytes;
  const totalMb = Math.round(totalBytes / 1024 / 1024);
  const usedMb = Math.round(usedBytes / 1024 / 1024);
  const freeMb = Math.round(freeBytes / 1024 / 1024);
  const usagePercent = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0;

  // Swap info is platform-specific; we'll try to get it
  let swapTotalMb = 0;
  let swapUsedMb = 0;

  return { totalMb, usedMb, freeMb, usagePercent, swapTotalMb, swapUsedMb };
}

async function getSwapInfo(): Promise<{ totalMb: number; usedMb: number }> {
  const platform = os.platform();
  try {
    if (platform === "darwin") {
      const { stdout } = await execFileAsync("sysctl", ["-n", "vm.swapusage"], { timeout: 5000 });
      // Format: "total = 2048.00M  used = 512.00M  free = 1536.00M ..."
      const totalMatch = stdout.match(/total\s*=\s*([\d.]+)M/);
      const usedMatch = stdout.match(/used\s*=\s*([\d.]+)M/);
      return {
        totalMb: totalMatch ? Math.round(Number.parseFloat(totalMatch[1])) : 0,
        usedMb: usedMatch ? Math.round(Number.parseFloat(usedMatch[1])) : 0,
      };
    }
    if (platform === "linux") {
      const { stdout } = await execFileAsync("free", ["-m"], { timeout: 5000 });
      const swapLine = stdout.split("\n").find((l) => l.startsWith("Swap:"));
      if (swapLine) {
        const parts = swapLine.split(/\s+/);
        return {
          totalMb: Number.parseInt(parts[1] ?? "0", 10),
          usedMb: Number.parseInt(parts[2] ?? "0", 10),
        };
      }
    }
  } catch {
    // swap info is best-effort
  }
  return { totalMb: 0, usedMb: 0 };
}

async function getGpuInfo(): Promise<GpuInfo[]> {
  const platform = os.platform();
  const gpus: GpuInfo[] = [];

  // Try nvidia-smi first (works on Linux/macOS with NVIDIA GPUs)
  try {
    const { stdout } = await execFileAsync(
      "nvidia-smi",
      [
        "--query-gpu=name,memory.total,memory.used,memory.free,utilization.gpu,temperature.gpu",
        "--format=csv,noheader,nounits",
      ],
      { timeout: 5000 },
    );
    for (const line of stdout.trim().split("\n")) {
      const parts = line.split(",").map((s) => s.trim());
      if (parts.length >= 6) {
        gpus.push({
          name: parts[0],
          memoryTotalMb: Number.parseInt(parts[1], 10) || undefined,
          memoryUsedMb: Number.parseInt(parts[2], 10) || undefined,
          memoryFreeMb: Number.parseInt(parts[3], 10) || undefined,
          utilizationPercent: Number.parseInt(parts[4], 10) || undefined,
          temperatureC: Number.parseInt(parts[5], 10) || undefined,
        });
      }
    }
    if (gpus.length > 0) return gpus;
  } catch {
    // nvidia-smi not available
  }

  // macOS: try system_profiler for Apple Silicon / discrete GPU info
  if (platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("system_profiler", ["SPDisplaysDataType", "-json"], {
        timeout: 10000,
      });
      const data = JSON.parse(stdout) as {
        SPDisplaysDataType?: Array<{
          _name?: string;
          sppci_model?: string;
          spdisplays_vram_shared?: string;
          spdisplays_vram?: string;
        }>;
      };
      const displays = data.SPDisplaysDataType ?? [];
      for (const gpu of displays) {
        const name = gpu.sppci_model ?? gpu._name ?? "Unknown GPU";
        const vramStr = gpu.spdisplays_vram_shared ?? gpu.spdisplays_vram ?? "";
        const vramMatch = vramStr.match(/([\d.]+)\s*(GB|MB)/i);
        let memoryTotalMb: number | undefined;
        if (vramMatch) {
          const val = Number.parseFloat(vramMatch[1]);
          memoryTotalMb =
            vramMatch[2].toUpperCase() === "GB" ? Math.round(val * 1024) : Math.round(val);
        }
        gpus.push({ name, memoryTotalMb });
      }
    } catch {
      // system_profiler not available or failed
    }
  }

  return gpus;
}

async function getDiskInfo(): Promise<DiskInfo[]> {
  try {
    const { stdout } = await execFileAsync("df", ["-m"], { timeout: 5000 });
    const lines = stdout.trim().split("\n").slice(1); // skip header
    const disks: DiskInfo[] = [];
    for (const line of lines) {
      const parts = line.split(/\s+/);
      if (parts.length < 6) continue;
      const filesystem = parts[0];
      // Skip pseudo-filesystems
      if (filesystem.startsWith("devfs") || filesystem === "map") continue;
      const sizeMb = Number.parseInt(parts[1], 10);
      const usedMb = Number.parseInt(parts[2], 10);
      const availableMb = Number.parseInt(parts[3], 10);
      const mount = parts[parts.length - 1];
      if (Number.isNaN(sizeMb) || sizeMb === 0) continue;
      const usagePercent = Math.round((usedMb / sizeMb) * 1000) / 10;
      disks.push({ filesystem, mount, sizeMb, usedMb, availableMb, usagePercent });
    }
    return disks;
  } catch {
    return [];
  }
}

async function getTopProcesses(topN: number): Promise<ProcessInfo[]> {
  const platform = os.platform();
  try {
    if (platform === "darwin" || platform === "linux") {
      const { stdout } = await execFileAsync("ps", ["aux", "--sort=-%cpu"], {
        timeout: 5000,
        env: { ...process.env, COLUMNS: "200" },
      });
      const lines = stdout.trim().split("\n").slice(1); // skip header
      const procs: ProcessInfo[] = [];
      for (const line of lines) {
        if (procs.length >= topN) break;
        const parts = line.split(/\s+/);
        if (parts.length < 11) continue;
        const pid = Number.parseInt(parts[1], 10);
        const cpuPercent = Number.parseFloat(parts[2]);
        const memMb = Number.parseInt(parts[5], 10) / 1024; // RSS in KB -> MB
        const name = parts.slice(10).join(" ");
        if (Number.isNaN(pid)) continue;
        procs.push({
          pid,
          name: name.length > 80 ? `${name.slice(0, 77)}...` : name,
          cpuPercent: Math.round(cpuPercent * 10) / 10,
          memoryMb: Math.round(memMb),
        });
      }
      return procs;
    }
  } catch {
    // fallback: no process info
  }
  return [];
}

export function createResourceMonitorTool(): AnyAgentTool {
  return {
    label: "Resource Monitor",
    name: "resource_monitor",
    description: [
      "Check system resource usage: CPU, memory (RAM), GPU/VRAM, disk, and top processes.",
      "Actions: snapshot (full overview), cpu, memory, gpu, disk, processes.",
      "Default action is snapshot which returns everything.",
    ].join(" "),
    parameters: ResourceMonitorSchema,
    execute: async (_toolCallId, args) => {
      const params = (args ?? {}) as Record<string, unknown>;
      const action =
        typeof params.action === "string" && params.action.trim()
          ? params.action.trim()
          : "snapshot";
      const topN =
        typeof params.topN === "number" && Number.isFinite(params.topN)
          ? Math.max(1, Math.min(50, Math.trunc(params.topN)))
          : 10;

      switch (action) {
        case "cpu":
          return jsonResult({ cpu: getCpuSnapshot() });

        case "memory": {
          const mem = getMemorySnapshot();
          const swap = await getSwapInfo();
          mem.swapTotalMb = swap.totalMb;
          mem.swapUsedMb = swap.usedMb;
          return jsonResult({ memory: mem });
        }

        case "gpu":
          return jsonResult({ gpu: await getGpuInfo() });

        case "disk":
          return jsonResult({ disk: await getDiskInfo() });

        case "processes":
          return jsonResult({ processes: await getTopProcesses(topN) });

        case "snapshot":
        default: {
          const mem = getMemorySnapshot();
          const swap = await getSwapInfo();
          mem.swapTotalMb = swap.totalMb;
          mem.swapUsedMb = swap.usedMb;
          const [gpu, disk, processes] = await Promise.all([
            getGpuInfo(),
            getDiskInfo(),
            getTopProcesses(topN),
          ]);
          return jsonResult({
            platform: os.platform(),
            arch: os.arch(),
            hostname: os.hostname(),
            uptimeSeconds: Math.round(os.uptime()),
            cpu: getCpuSnapshot(),
            memory: mem,
            gpu,
            disk,
            processes,
          });
        }
      }
    },
  };
}
