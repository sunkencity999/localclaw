import type { Server } from "node:http";
import type { Duplex } from "node:stream";
import express from "express";
import { connect as netConnect } from "node:net";
import type { BrowserRouteRegistrar } from "./routes/types.js";
import { loadConfig } from "../config/config.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveBrowserConfig, resolveProfile } from "./config.js";
import { ensureChromeExtensionRelayServer } from "./extension-relay.js";
import { registerBrowserRoutes } from "./routes/index.js";
import { type BrowserServerState, createBrowserRouteContext } from "./server-context.js";

let state: BrowserServerState | null = null;
const log = createSubsystemLogger("browser");
const logServer = log.child("server");

export async function startBrowserControlServerFromConfig(): Promise<BrowserServerState | null> {
  if (state) {
    return state;
  }

  const cfg = loadConfig();
  const resolved = resolveBrowserConfig(cfg.browser, cfg);
  if (!resolved.enabled) {
    return null;
  }

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  const ctx = createBrowserRouteContext({
    getState: () => state,
  });
  registerBrowserRoutes(app as unknown as BrowserRouteRegistrar, ctx);

  const port = resolved.controlPort;
  const server = await new Promise<Server>((resolve, reject) => {
    const s = app.listen(port, "127.0.0.1", () => resolve(s));
    s.once("error", reject);
  }).catch((err) => {
    logServer.error(`openclaw browser server failed to bind 127.0.0.1:${port}: ${String(err)}`);
    return null;
  });

  if (!server) {
    return null;
  }

  state = {
    server,
    port,
    resolved,
    profiles: new Map(),
  };

  // If any profile uses the Chrome extension relay, start the local relay server eagerly
  // so the extension can connect before the first browser action.
  for (const name of Object.keys(resolved.profiles)) {
    const profile = resolveProfile(resolved, name);
    if (!profile || profile.driver !== "extension") {
      continue;
    }
    await ensureChromeExtensionRelayServer({ cdpUrl: profile.cdpUrl }).catch((err) => {
      logServer.warn(`Chrome extension relay init failed for profile "${name}": ${String(err)}`);
    });
  }

  // Forward /extension WebSocket upgrades from the browser control port to
  // the extension relay server.  The Chrome extension defaults to port 18792
  // which only matches the relay port for gateway=18789.  This proxy ensures
  // the extension can connect via the browser control port regardless of the
  // gateway port configuration (e.g. LocalClaw on 18790).
  for (const name of Object.keys(resolved.profiles)) {
    const profile = resolveProfile(resolved, name);
    if (!profile || profile.driver !== "extension") {
      continue;
    }
    const relayPort = profile.cdpPort;
    if (relayPort === port) {
      break;
    }
    server.on(
      "upgrade",
      (
        req: { url?: string; method?: string; httpVersion: string; rawHeaders: string[] },
        socket: Duplex,
        head: Buffer,
      ) => {
        const pathname = (req.url ?? "/").split("?")[0];
        if (pathname !== "/extension") {
          return;
        }
        const upstream = netConnect({ host: "127.0.0.1", port: relayPort }, () => {
          let raw = `${req.method ?? "GET"} /extension HTTP/${req.httpVersion}\r\n`;
          for (let i = 0; i < req.rawHeaders.length; i += 2) {
            const key = req.rawHeaders[i];
            const val = req.rawHeaders[i + 1];
            raw +=
              key?.toLowerCase() === "host"
                ? `Host: 127.0.0.1:${relayPort}\r\n`
                : `${key}: ${val}\r\n`;
          }
          raw += "\r\n";
          upstream.write(raw);
          if (head.length > 0) {
            upstream.write(head);
          }
          upstream.pipe(socket);
          socket.pipe(upstream);
        });
        upstream.on("error", () => {
          try {
            socket.destroy();
          } catch {}
        });
        socket.on("error", () => {
          try {
            upstream.destroy();
          } catch {}
        });
      },
    );
    logServer.info(`Extension WebSocket proxy: :${port}/extension → :${relayPort}/extension`);
    break;
  }

  logServer.info(`Browser control listening on http://127.0.0.1:${port}/`);
  return state;
}

export async function stopBrowserControlServer(): Promise<void> {
  const current = state;
  if (!current) {
    return;
  }

  const ctx = createBrowserRouteContext({
    getState: () => state,
  });

  try {
    const current = state;
    if (current) {
      for (const name of Object.keys(current.resolved.profiles)) {
        try {
          await ctx.forProfile(name).stopRunningBrowser();
        } catch {
          // ignore
        }
      }
    }
  } catch (err) {
    logServer.warn(`openclaw browser stop failed: ${String(err)}`);
  }

  if (current.server) {
    await new Promise<void>((resolve) => {
      current.server?.close(() => resolve());
    });
  }
  state = null;

  // Optional: Playwright is not always available (e.g. embedded gateway builds).
  try {
    const mod = await import("./pw-ai.js");
    await mod.closePlaywrightBrowserConnection();
  } catch {
    // ignore
  }
}
