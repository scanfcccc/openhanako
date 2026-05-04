#!/usr/bin/env node
import fs from "fs";
import http from "http";
import { spawn, spawnSync } from "child_process";
import { createReadStream } from "fs";
import path from "path";
import os from "os";
import { WebSocketServer, WebSocket } from "ws";

const projectRoot = path.resolve(new URL("..", import.meta.url).pathname);
const ensure = spawnSync(process.execPath, ["scripts/ensure-native.cjs"], {
  cwd: projectRoot,
  stdio: "inherit",
  env: process.env,
});
if (ensure.status !== 0) {
  console.warn("[web] warning: ensure-native failed, continuing startup (you can run `npm run rebuild`).");
}

const rendererDir = path.join(projectRoot, "desktop", "dist-renderer");
if (!fs.existsSync(path.join(rendererDir, "index.html"))) {
  console.error("[web] missing desktop/dist-renderer/index.html, run: npm run build:renderer");
  process.exit(1);
}

const hanakoHome = process.env.HANA_HOME
  ? path.resolve(process.env.HANA_HOME.replace(/^~/, os.homedir()))
  : path.join(os.homedir(), ".hanako");
const serverInfoPath = path.join(hanakoHome, "server-info.json");

const serverProc = spawn(process.execPath, ["server/index.js"], {
  cwd: projectRoot,
  env: { ...process.env, HANA_INTERFACE: "none", HANA_ALLOW_UTILITY_LARGE_FALLBACK: process.env.HANA_ALLOW_UTILITY_LARGE_FALLBACK || "1" },
  stdio: ["ignore", "inherit", "inherit", "ipc"],
});

async function waitServerInfo(timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const info = JSON.parse(fs.readFileSync(serverInfoPath, "utf8"));
      if (info?.port && info?.token) return info;
    } catch {}
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error("wait server-info timeout");
}

function getMime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
  }[ext] || "application/octet-stream";
}

async function start() {
  const info = await waitServerInfo();
  const backendPort = info.port;
  const token = info.token;

  const webPort = Number(process.env.HANA_WEB_PORT || 5180);
  const wss = new WebSocketServer({ noServer: true });

  const proxyHttp = async (req, res) => {
    const headers = { ...req.headers, authorization: `Bearer ${token}` };
    delete headers.host;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const target = `http://127.0.0.1:${backendPort}${req.url}`;
    const upstream = await fetch(target, { method: req.method, headers, body });
    res.writeHead(upstream.status, Object.fromEntries(upstream.headers.entries()));
    const arr = new Uint8Array(await upstream.arrayBuffer());
    res.end(arr);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (url.pathname.startsWith("/api/")) {
      try { return await proxyHttp(req, res); }
      catch (e) {
        res.writeHead(502, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: e.message }));
      }
    }

    let rel = decodeURIComponent(url.pathname);
    if (rel === "/") rel = "/index.html";
    const abs = path.normalize(path.join(rendererDir, rel));
    if (!abs.startsWith(rendererDir) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("Not Found");
    }
    res.writeHead(200, { "Content-Type": getMime(abs), "Cache-Control": "no-cache" });
    createReadStream(abs).pipe(res);
  });

  server.on("upgrade", (req, socket, head) => {
    if (!req.url?.startsWith("/ws")) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (client) => {
      const upstream = new WebSocket(`ws://127.0.0.1:${backendPort}/ws?token=${token}`);
      client.on("message", (m) => upstream.readyState === WebSocket.OPEN && upstream.send(m));
      upstream.on("message", (m) => client.readyState === WebSocket.OPEN && client.send(m));
      const closeBoth = () => {
        try { client.close(); } catch {}
        try { upstream.close(); } catch {}
      };
      client.on("close", closeBoth);
      upstream.on("close", closeBoth);
    });
  });

  server.listen(webPort, "127.0.0.1", () => {
    console.log(`[web] UI ready: http://127.0.0.1:${webPort}/?token=${token}`);
    console.log(`[web] backend: http://127.0.0.1:${backendPort}`);
  });

  const stop = () => {
    try { server.close(); } catch {}
    try { serverProc.kill("SIGTERM"); } catch {}
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

start().catch((err) => {
  console.error("[web] start failed:", err.message);
  try { serverProc.kill("SIGTERM"); } catch {}
  process.exit(1);
});
