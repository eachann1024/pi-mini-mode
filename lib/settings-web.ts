import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

export interface SettingsWebOptions {
  idleTimeoutMs?: number;
  onClose?: () => void;
}

const DEFAULT_IDLE_TIMEOUT_MS = 300_000;
const MIN_IDLE_TIMEOUT_MS = 1_000;
const MAX_IDLE_TIMEOUT_MS = 3_600_000;

/** Env override is validated to 1s..1h; a test override wins and is trusted. */
function configuredIdleTimeout(override: number | undefined): number {
  if (override !== undefined) {
    if (!Number.isFinite(override) || override <= 0) throw new TypeError("Invalid idle timeout");
    return override;
  }
  const raw = process.env.PI_MINI_MODE_SETTINGS_IDLE_MS;
  const value = Number(raw);
  return raw !== undefined && Number.isInteger(value) && value >= MIN_IDLE_TIMEOUT_MS && value <= MAX_IDLE_TIMEOUT_MS
    ? value : DEFAULT_IDLE_TIMEOUT_MS;
}

/** On-demand, loopback-only settings bridge; no polling or third-party runtime. */
export async function startSettingsWeb(snapshot: () => unknown, update: (value: unknown) => Promise<void>, options: SettingsWebOptions = {}) {
  const token = randomBytes(24).toString("hex");
  const idleTimeoutMs = configuredIdleTimeout(options.idleTimeoutMs);
  let origin = "";
  let queue = Promise.resolve();
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let idleDeadline = Date.now() + idleTimeoutMs;
  let closed = false;
  let activeRequests = 0;
  const close = () => {
    if (closed) return;
    closed = true;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
    server.close();
    server.closeAllConnections();
    options.onClose?.();
  };
  const armIdle = () => {
    if (closed || activeRequests > 0) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(close, Math.max(0, idleDeadline - Date.now()));
    idleTimer.unref();
  };
  /** Successful authorized traffic renews; failed or anonymous requests keep the old deadline. */
  const touch = () => {
    idleDeadline = Date.now() + idleTimeoutMs;
    armIdle();
  };
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    if (req.headers.host !== origin.slice(7) || (req.headers.origin && req.headers.origin !== origin)) {
      res.writeHead(403).end(); return;
    }
    if (req.url === "/" && req.method === "GET") {
      try {
        const html = await readFile(new URL("./settings.html", import.meta.url));
        res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(html);
      } catch {
        res.writeHead(503).end("Settings page unavailable. Reload Pi and reopen settings.");
      }
      return;
    }
    if (req.url !== "/settings" || req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(403).end(); return;
    }
    // Suspend the idle lease while handling so a slow save cannot be cut off;
    // only a successful response re-arms it.
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
    let renewed = false;
    activeRequests++;
    try {
      if (req.method === "PUT") {
        if (req.headers["content-type"] !== "application/json") { res.writeHead(415).end(); return; }
        let body = "";
        for await (const chunk of req) {
          body += chunk;
          if (Buffer.byteLength(body) > 16384) { res.writeHead(413).end(); return; }
        }
        const value: unknown = JSON.parse(body);
        const saving = queue.then(() => update(value));
        queue = saving.catch(() => {});
        await saving;
      } else if (req.method !== "GET") { res.writeHead(405).end(); return; }
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify(snapshot()));
      renewed = true;
    } catch (error) {
      res.writeHead(error instanceof TypeError || error instanceof SyntaxError ? 400 : 500);
      res.end("无法保存设置，请检查配置文件权限后重试。");
    } finally {
      activeRequests--;
      if (renewed) touch();
      else armIdle();
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("无法启动设置服务");
  origin = `http://127.0.0.1:${address.port}`;
  server.unref();
  touch();
  return {
    url: `${origin}/#${token}`,
    get closed() { return closed; },
    touch,
    close,
  };
}
