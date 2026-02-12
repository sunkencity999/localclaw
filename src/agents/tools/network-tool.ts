import { Type } from "@sinclair/typebox";
import { execFile } from "node:child_process";
import dns from "node:dns/promises";
import net from "node:net";
import { promisify } from "node:util";
import { optionalStringEnum } from "../schema/typebox.js";
import { type AnyAgentTool, jsonResult, readStringParam } from "./common.js";

const execFileAsync = promisify(execFile);

const NETWORK_ACTIONS = [
  "ping",
  "dns_lookup",
  "port_check",
  "http_check",
  "traceroute",
  "interfaces",
  "connections",
] as const;

const NetworkToolSchema = Type.Object({
  action: optionalStringEnum(NETWORK_ACTIONS),
  host: Type.Optional(Type.String({ description: "Hostname or IP address" })),
  port: Type.Optional(Type.Number({ description: "Port number for port_check" })),
  ports: Type.Optional(Type.Array(Type.Number(), { description: "Multiple ports to check" })),
  url: Type.Optional(Type.String({ description: "URL for http_check" })),
  count: Type.Optional(Type.Number({ description: "Ping count (default 4)" })),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (default 5)" })),
  recordType: Type.Optional(
    Type.String({ description: "DNS record type: A, AAAA, MX, TXT, NS, CNAME, SRV (default: A)" }),
  ),
});

async function pingHost(
  host: string,
  count: number,
  timeout: number,
): Promise<Record<string, unknown>> {
  const args =
    process.platform === "darwin"
      ? ["-c", String(count), "-W", String(timeout * 1000), host]
      : ["-c", String(count), "-W", String(timeout), host];

  try {
    const { stdout } = await execFileAsync("ping", args, {
      timeout: (timeout + 2) * count * 1000,
    });

    // Parse ping stats
    const statsLine = stdout.match(/(\d+) packets transmitted, (\d+) (?:packets )?received/);
    const rttLine = stdout.match(
      /(?:rtt|round-trip) min\/avg\/max\/(?:mdev|stddev) = ([\d.]+)\/([\d.]+)\/([\d.]+)\/([\d.]+)/,
    );

    return {
      host,
      reachable: true,
      transmitted: statsLine ? Number.parseInt(statsLine[1], 10) : count,
      received: statsLine ? Number.parseInt(statsLine[2], 10) : 0,
      lossPercent: statsLine
        ? Math.round(
            ((Number.parseInt(statsLine[1], 10) - Number.parseInt(statsLine[2], 10)) /
              Number.parseInt(statsLine[1], 10)) *
              100,
          )
        : 100,
      rttMin: rttLine ? Number.parseFloat(rttLine[1]) : null,
      rttAvg: rttLine ? Number.parseFloat(rttLine[2]) : null,
      rttMax: rttLine ? Number.parseFloat(rttLine[3]) : null,
      raw: stdout.trim(),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { host, reachable: false, error: message };
  }
}

async function dnsLookup(host: string, recordType: string): Promise<Record<string, unknown>> {
  const type = recordType.toUpperCase();

  try {
    switch (type) {
      case "A": {
        const addresses = await dns.resolve4(host);
        return { host, type, records: addresses };
      }
      case "AAAA": {
        const addresses = await dns.resolve6(host);
        return { host, type, records: addresses };
      }
      case "MX": {
        const records = await dns.resolveMx(host);
        return {
          host,
          type,
          records: records.map((r) => ({ exchange: r.exchange, priority: r.priority })),
        };
      }
      case "TXT": {
        const records = await dns.resolveTxt(host);
        return { host, type, records: records.map((r) => r.join("")) };
      }
      case "NS": {
        const records = await dns.resolveNs(host);
        return { host, type, records };
      }
      case "CNAME": {
        const records = await dns.resolveCname(host);
        return { host, type, records };
      }
      case "SRV": {
        const records = await dns.resolveSrv(host);
        return { host, type, records };
      }
      default: {
        const addresses = await dns.resolve(host, type);
        return { host, type, records: addresses };
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { host, type, error: message };
  }
}

async function checkPort(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<{ port: number; open: boolean; latencyMs?: number; error?: string }> {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = new net.Socket();

    socket.setTimeout(timeoutMs);

    socket.on("connect", () => {
      const latencyMs = Date.now() - start;
      socket.destroy();
      resolve({ port, open: true, latencyMs });
    });

    socket.on("timeout", () => {
      socket.destroy();
      resolve({ port, open: false, error: "timeout" });
    });

    socket.on("error", (err) => {
      socket.destroy();
      resolve({ port, open: false, error: err.message });
    });

    socket.connect(port, host);
  });
}

async function httpCheck(url: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const response = await fetch(url, {
      method: "HEAD",
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timer);

    return {
      url,
      status: response.status,
      statusText: response.statusText,
      ok: response.ok,
      latencyMs: Date.now() - start,
      headers: Object.fromEntries(
        [...response.headers.entries()].filter(([k]) =>
          ["content-type", "server", "x-powered-by", "content-length", "location"].includes(
            k.toLowerCase(),
          ),
        ),
      ),
    };
  } catch (err) {
    return {
      url,
      ok: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function getInterfaces(): Promise<Record<string, unknown>> {
  const { networkInterfaces } = await import("node:os");
  const ifaces = networkInterfaces();
  const result: Record<string, unknown>[] = [];

  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      result.push({
        name,
        address: addr.address,
        family: addr.family,
        internal: addr.internal,
        netmask: addr.netmask,
        mac: addr.mac,
      });
    }
  }

  return {
    interfaces: result.filter((i) => !i.internal),
    all: result,
  };
}

async function getConnections(): Promise<Record<string, unknown>> {
  try {
    const cmd = process.platform === "darwin" ? "netstat" : "ss";
    const args = process.platform === "darwin" ? ["-an", "-p", "tcp"] : ["-tulnp"];

    const { stdout } = await execFileAsync(cmd, args, {
      timeout: 10_000,
      maxBuffer: 5 * 1024 * 1024,
    });

    const lines = stdout.trim().split("\n");
    // Parse listening ports
    const listening: Array<{ protocol: string; address: string; port: number }> = [];

    for (const line of lines) {
      if (!line.includes("LISTEN")) continue;
      // macOS netstat: tcp4  0  0  *.8080  *.*  LISTEN
      // Linux ss: tcp  LISTEN  0  128  0.0.0.0:8080  0.0.0.0:*
      const parts = line.trim().split(/\s+/);
      if (process.platform === "darwin") {
        const localAddr = parts[3];
        if (localAddr) {
          const lastDot = localAddr.lastIndexOf(".");
          if (lastDot >= 0) {
            const addr = localAddr.slice(0, lastDot);
            const port = Number.parseInt(localAddr.slice(lastDot + 1), 10);
            if (!Number.isNaN(port)) {
              listening.push({ protocol: parts[0], address: addr, port });
            }
          }
        }
      } else {
        const localAddr = parts[4];
        if (localAddr) {
          const lastColon = localAddr.lastIndexOf(":");
          if (lastColon >= 0) {
            const port = Number.parseInt(localAddr.slice(lastColon + 1), 10);
            if (!Number.isNaN(port)) {
              listening.push({
                protocol: parts[0],
                address: localAddr.slice(0, lastColon),
                port,
              });
            }
          }
        }
      }
    }

    return {
      listeningCount: listening.length,
      listening: listening.sort((a, b) => a.port - b.port),
    };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export function createNetworkTool(): AnyAgentTool {
  return {
    label: "Network",
    name: "network",
    description: [
      "Network diagnostics and connectivity checks (local, no cloud dependencies).",
      "Actions: ping (ICMP), dns_lookup (resolve records), port_check (TCP connect),",
      "http_check (HEAD request), traceroute, interfaces (local NICs),",
      "connections (listening ports).",
    ].join(" "),
    parameters: NetworkToolSchema,
    execute: async (_toolCallId, args) => {
      const params = (args ?? {}) as Record<string, unknown>;
      const action =
        typeof params.action === "string" && params.action.trim()
          ? params.action.trim()
          : "interfaces";

      const timeout =
        typeof params.timeout === "number" && Number.isFinite(params.timeout)
          ? Math.max(1, Math.min(30, params.timeout))
          : 5;

      switch (action) {
        case "ping": {
          const host = readStringParam(params, "host", { required: true });
          const count =
            typeof params.count === "number" && Number.isFinite(params.count)
              ? Math.max(1, Math.min(20, Math.trunc(params.count)))
              : 4;
          const result = await pingHost(host, count, timeout);
          const text = result.reachable
            ? `${host}: ${result.received}/${result.transmitted} packets, avg ${result.rttAvg}ms`
            : `${host}: unreachable - ${result.error}`;
          return {
            content: [{ type: "text", text }],
            details: result,
          };
        }

        case "dns_lookup": {
          const host = readStringParam(params, "host", { required: true });
          const recordType =
            typeof params.recordType === "string" && params.recordType.trim()
              ? params.recordType.trim()
              : "A";
          const result = await dnsLookup(host, recordType);
          return jsonResult(result);
        }

        case "port_check": {
          const host = readStringParam(params, "host", { required: true });
          const timeoutMs = timeout * 1000;

          let ports: number[] = [];
          if (Array.isArray(params.ports)) {
            ports = params.ports
              .filter((p): p is number => typeof p === "number")
              .filter((p) => p >= 1 && p <= 65535);
          } else if (typeof params.port === "number") {
            ports = [params.port];
          } else {
            throw new Error("port or ports required for port_check");
          }

          const results = await Promise.all(ports.map((port) => checkPort(host, port, timeoutMs)));

          const text = results
            .map(
              (r) =>
                `${host}:${r.port} - ${r.open ? "OPEN" : "CLOSED"}${r.latencyMs ? ` (${r.latencyMs}ms)` : ""}`,
            )
            .join("\n");

          return {
            content: [{ type: "text", text }],
            details: {
              host,
              results,
              openCount: results.filter((r) => r.open).length,
              closedCount: results.filter((r) => !r.open).length,
            },
          };
        }

        case "http_check": {
          const url = readStringParam(params, "url", { required: true });
          const result = await httpCheck(url, timeout * 1000);
          return jsonResult(result);
        }

        case "traceroute": {
          const host = readStringParam(params, "host", { required: true });
          const cmd = process.platform === "darwin" ? "traceroute" : "traceroute";
          const maxHops = 20;

          try {
            const { stdout } = await execFileAsync(
              cmd,
              ["-m", String(maxHops), "-w", String(timeout), host],
              { timeout: maxHops * timeout * 1000 + 5000 },
            );

            const hops = stdout
              .trim()
              .split("\n")
              .slice(1)
              .map((line) => line.trim());

            return {
              content: [{ type: "text", text: stdout.trim() }],
              details: { host, hopCount: hops.length },
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return jsonResult({ host, error: message });
          }
        }

        case "interfaces": {
          const result = await getInterfaces();
          const ifaces = result.interfaces as Array<Record<string, unknown>>;
          const text = ifaces
            .map((i) => `${i.name}: ${i.address} (${i.family}) mac=${i.mac}`)
            .join("\n");
          return {
            content: [{ type: "text", text: text || "(no external interfaces)" }],
            details: result,
          };
        }

        case "connections": {
          const result = await getConnections();
          const listening = (result.listening ?? []) as Array<Record<string, unknown>>;
          const text = listening.map((l) => `${l.protocol} ${l.address}:${l.port}`).join("\n");
          return {
            content: [
              {
                type: "text",
                text: text || "(no listening ports found)",
              },
            ],
            details: result,
          };
        }

        default:
          throw new Error(`Unknown network action: ${action}`);
      }
    },
  };
}
