import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

/** On-demand, loopback-only settings bridge; no polling or third-party runtime. */
export async function startSettingsWeb(snapshot: () => unknown, update: (value: unknown) => Promise<void>) {
  const token = randomBytes(24).toString("hex");
  const html = await readFile(new URL("./settings.html", import.meta.url));
  let origin = "";
  let queue = Promise.resolve();
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    if (req.headers.host !== origin.slice(7) || (req.headers.origin && req.headers.origin !== origin)) {
      res.writeHead(403).end(); return;
    }
    if (req.url === "/" && req.method === "GET") {
      res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(html); return;
    }
    if (req.url !== "/settings" || req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(403).end(); return;
    }
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
    } catch (error) {
      res.writeHead(error instanceof TypeError || error instanceof SyntaxError ? 400 : 500);
      res.end("无法保存设置，请检查配置文件权限后重试。");
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
  return { url: `${origin}/#${token}`, close() { server.close(); server.closeAllConnections(); } };
}
