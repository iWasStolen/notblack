#!/usr/bin/env node
/* ============================================================
   Memphis unBLACKed — Render.com single-port gateway (PID 1)

   Render exposes exactly ONE public port per web service. This app
   is three processes behind one router:

     [gateway :$PORT]  ── HTTP/WS router + supervisor
       ├── Next.js standalone   (node,  $NEXT_PORT default 3000)
       ├── wisp relay           (bun,   $WISP_PORT  default 3001)
       └── chat service         (bun,   $CHAT_PORT  default 3003)

   ROUTING (mirrors the z.ai sandbox gateway, restricted to the two
   known ports — a client cannot pick an arbitrary backend):

     HTTP  + WS   query XTransformPort=3001  → wisp   (wispHealth + wss)
     WS          path  /wisp/*               → wisp   (Scramjet transports)
     HTTP  + WS   query XTransformPort=3003  → chat   (socket.io polling + ws)
     everything else                          → Next

   The client URLs are unchanged from the sandbox build:
     wss://<host>/wisp/?XTransformPort=3001&/
     io("/?XTransformPort=3003")

   BOOT SEQUENCE
     1. resolve DATABASE_URL (default file:/app/db/custom.db), mkdir
     2. optional ZAI_CONFIG env (JSON) → /etc/.z-ai-config + app dir
        (the z-ai-web-dev-sdk reads its credentials from that file)
     3. prisma db push --skip-generate  (creates / migrates the
        SQLite file — fresh disks, ephemeral restarts and schema
        drift are all covered; failures log a warning and continue)
     4. spawn wisp, chat, next (restart with backoff on crash)
     5. listen on $PORT

   Plain CommonJS, no dependencies — runs under node or bun.
   ============================================================ */

"use strict";

const http = require("http");
const net = require("net");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

/* ---------------- configuration ---------------- */

const PORT = Number(process.env.PORT) || 10000;
const NEXT_PORT = Number(process.env.NEXT_PORT) || 3000;
const WISP_PORT = Number(process.env.WISP_PORT) || 3001;
const CHAT_PORT = Number(process.env.CHAT_PORT) || 3003;
const HOST = "127.0.0.1";

const APP_DIR = path.resolve(__dirname, "..");
/* where the Next standalone server.js lives */
const NEXT_DIR = process.env.NEXT_DIR || APP_DIR;
/* directory holding the bundled mini-service-*.js files */
const SERVICES_DIR = process.env.SERVICES_DIR || path.join(APP_DIR, "mini-services-dist");
/* prisma CLI entry (isolated install so the runtime image stays slim) */
const PRISMA_CLI = process.env.PRISMA_CLI || path.join(APP_DIR, "prisma-cli", "node_modules", "prisma", "build", "index.js");
const SCHEMA_PATH = process.env.SCHEMA_PATH || path.join(APP_DIR, "prisma", "schema.prisma");

const NODE_BIN = process.env.NODE_BIN || "node";
const BUN_BIN = process.env.BUN_BIN || "bun";

const DATABASE_URL =
  process.env.DATABASE_URL && process.env.DATABASE_URL.startsWith("file:")
    ? process.env.DATABASE_URL
    : "file:/app/db/custom.db";

/* ---------------- small helpers ---------------- */

function log(tag, msg) {
  const line = typeof msg === "string" ? msg : JSON.stringify(msg);
  console.log(`[gateway:${tag}] ${line}`);
}

/** file: URL → absolute fs path (relative resolved against APP_DIR). */
function sqlitePath(url) {
  let p = url.slice("file:".length);
  const q = p.indexOf("?");
  if (q !== -1) p = p.slice(0, q);
  if (!path.isAbsolute(p)) p = path.join(APP_DIR, p);
  return p;
}

function queryParam(reqUrl, name) {
  const q = reqUrl.indexOf("?");
  if (q === -1) return null;
  for (const pair of reqUrl.slice(q + 1).split("&")) {
    const eq = pair.indexOf("=");
    const k = eq === -1 ? pair : pair.slice(0, eq);
    if (decodeURIComponent(k) === name)
      return eq === -1 ? "" : decodeURIComponent(pair.slice(eq + 1));
  }
  return null;
}

/* ---------------- boot: DB + AI config ---------------- */

function writeZaiConfig() {
  const raw = process.env.ZAI_CONFIG;
  if (!raw) return;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    log("zai", "ZAI_CONFIG is set but not valid JSON — skipping");
    return;
  }
  if (!parsed.baseUrl || !parsed.apiKey) {
    log("zai", "ZAI_CONFIG must be { baseUrl, apiKey } — skipping");
    return;
  }
  /* the SDK checks process.cwd()/.z-ai-config, ~/.z-ai-config and
     /etc/.z-ai-config — write the two deterministic ones */
  for (const target of ["/etc/.z-ai-config", path.join(APP_DIR, ".z-ai-config")]) {
    try {
      fs.writeFileSync(target, JSON.stringify(parsed), { mode: 0o600 });
      log("zai", `AI credentials installed at ${target}`);
    } catch (e) {
      log("zai", `could not write ${target} (${e.message})`);
    }
  }
}

function dbPush() {
  return new Promise((resolve) => {
    const dbFile = sqlitePath(DATABASE_URL);
    fs.mkdirSync(path.dirname(dbFile), { recursive: true });
    if (!fs.existsSync(PRISMA_CLI)) {
      log("db", `prisma CLI not found at ${PRISMA_CLI} — skipping db push`);
      return resolve();
    }
    log("db", `pushing schema to ${dbFile}`);
    const child = spawn(
      NODE_BIN,
      [PRISMA_CLI, "db", "push", "--skip-generate", "--schema", SCHEMA_PATH, "--accept-data-loss"],
      { env: { ...process.env, DATABASE_URL }, stdio: ["ignore", "pipe", "pipe"], cwd: APP_DIR }
    );
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (e) => {
      log("db", `prisma CLI failed to start: ${e.message}`);
      resolve();
    });
    child.on("close", (code) => {
      /* --accept-data-loss keeps it non-interactive in CI: a drifting
         on-disk schema is auto-migrated so deploys never hang on a
         prompt. prisma never drops data out of the blue — this only
         fires when the schema genuinely diverged. */
      if (code === 0) log("db", "schema is in sync");
      else log("db", `db push exited ${code} — continuing with existing file\n${out.trim().slice(-800)}`);
      resolve();
    });
  });
}

/* ---------------- child supervision ---------------- */

const children = new Map(); /* name → { proc, restarting } */
let shuttingDown = false;

function startService(name, bin, args, env, cwd, backoffMs) {
  if (shuttingDown) return;
  const proc = spawn(bin, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"] });
  children.set(name, { proc, backoffMs });
  const prefix = (stream) => (chunk) => {
    for (const line of String(chunk).split("\n")) {
      if (line.trim()) console.log(`[${name}] ${line}`);
    }
  };
  proc.stdout.on("data", prefix());
  proc.stderr.on("data", prefix());
  log("sup", `${name} started (pid ${proc.pid})`);
  const startedAt = Date.now();
  proc.on("close", (code, signal) => {
    if (shuttingDown) return;
    const uptime = Date.now() - startedAt;
    const next = uptime > 60_000 ? 1000 : Math.min((backoffMs || 1000) * 2, 15_000);
    log("sup", `${name} exited (code=${code} signal=${signal}) after ${(uptime / 1000).toFixed(1)}s — restarting in ${next / 1000}s`);
    setTimeout(() => startService(name, bin, args, env, cwd, next), next);
  });
}

function startChildren() {
  const baseEnv = { ...process.env, DATABASE_URL };

  /* wisp relay — bundled by the Dockerfile, run with bun */
  startService(
    "wisp",
    BUN_BIN,
    [path.join(SERVICES_DIR, "mini-service-wisp-service.js")],
    { ...baseEnv, PORT: String(WISP_PORT) },
    SERVICES_DIR,
    1000
  );

  /* chat service — shares the SQLite DB (bun:sqlite) */
  startService(
    "chat",
    BUN_BIN,
    [path.join(SERVICES_DIR, "mini-service-chat-service.js")],
    { ...baseEnv, PORT: String(CHAT_PORT), DB_PATH: sqlitePath(DATABASE_URL) },
    SERVICES_DIR,
    1000
  );

  /* Next.js standalone — node (Next's own supported runtime).
     HOSTNAME is forced: Render sets it to the container hostname,
     which standalone would try to bind to. */
  startService(
    "next",
    NODE_BIN,
    [path.join(NEXT_DIR, "server.js")],
    { ...baseEnv, PORT: String(NEXT_PORT), HOSTNAME: "0.0.0.0", NODE_ENV: "production" },
    NEXT_DIR,
    1000
  );
}

function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("sup", `${sig} received — stopping children`);
  for (const { proc } of children.values()) {
    try { proc.kill("SIGTERM"); } catch {}
  }
  setTimeout(() => {
    for (const { proc } of children.values()) {
      try { proc.kill("SIGKILL"); } catch {}
    }
    process.exit(0);
  }, 8000).unref();
  /* exit as soon as every child is gone */
  const check = setInterval(() => {
    if (![...children.values()].some(({ proc }) => proc.exitCode === null && !proc.killed)) {
      clearInterval(check);
      process.exit(0);
    }
  }, 250);
  check.unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

/* ---------------- routing + proxying ---------------- */

const HOP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
]);

function connTokens(headerValue) {
  return String(headerValue || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/* the tokens clients hardcode in URLs (sandbox convention) */
const WISP_PUBLIC_TOKEN = process.env.WISP_PUBLIC_TOKEN || "3001";
const CHAT_PUBLIC_TOKEN = process.env.CHAT_PUBLIC_TOKEN || "3003";

function routeHttp(req) {
  const tp = queryParam(req.url, "XTransformPort");
  if (tp === WISP_PUBLIC_TOKEN) return WISP_PORT;
  if (tp === CHAT_PUBLIC_TOKEN) return CHAT_PORT;
  return NEXT_PORT;
}

function routeUpgrade(req) {
  const tp = queryParam(req.url, "XTransformPort");
  const q = req.url.indexOf("?");
  const pathname = q === -1 ? req.url : req.url.slice(0, q);
  if (tp === WISP_PUBLIC_TOKEN || pathname === "/wisp" || pathname.startsWith("/wisp/"))
    return WISP_PORT;
  if (tp === CHAT_PUBLIC_TOKEN) return CHAT_PORT;
  return NEXT_PORT;
}

function proxyHttp(req, res) {
  const port = routeHttp(req);
  const headers = { ...req.headers };
  for (const h of [...HOP_HEADERS, ...connTokens(req.headers.connection)]) delete headers[h];

  const up = http.request(
    { host: HOST, port, method: req.method, path: req.url, headers },
    (ur) => {
      const h2 = { ...ur.headers };
      for (const h of [...HOP_HEADERS, ...connTokens(ur.headers.connection)]) delete h2[h];
      res.writeHead(ur.statusCode, ur.statusMessage, h2);
      ur.pipe(res); /* streaming-safe: SSE (AI chat) is never buffered */
    }
  );
  up.on("error", (e) => {
    log("http", `upstream :${port} error — ${e.message}`);
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end(`memphis gateway: upstream ${HOST}:${port} is unavailable (${e.message})`);
  });
  req.pipe(up);
}

function proxyUpgrade(req, socket, head) {
  const port = routeUpgrade(req);
  const up = net.connect(port, HOST);
  up.on("connect", () => {
    /* replay the original request byte-for-byte (rawHeaders keeps the
       exact casing the WS handshake was signed with) */
    let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      raw += `${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`;
    }
    up.write(raw + "\r\n");
    if (head && head.length) up.write(head);
    socket.pipe(up);
    up.pipe(socket);
  });
  up.on("error", () => socket.destroy());
  socket.on("error", () => up.destroy());
}

/* ---------------- main ---------------- */

async function main() {
  log("boot", `public :${PORT} → next :${NEXT_PORT} · wisp :${WISP_PORT} · chat :${CHAT_PORT}`);
  log("boot", `database ${DATABASE_URL}`);

  writeZaiConfig();
  await dbPush();
  startChildren();

  const server = http.createServer(proxyHttp);
  server.on("upgrade", proxyUpgrade);
  /* long-lived: proxied pages, SSE streams and websockets — no
     server-level request timeout may cut them */
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 65_000;

  server.on("error", (e) => {
    log("http", `fatal: ${e.message}`);
    process.exit(1);
  });
  server.listen(PORT, "0.0.0.0", () => {
    log("http", `listening on 0.0.0.0:${PORT}`);
  });
}

main().catch((e) => {
  log("boot", `fatal: ${e.stack || e.message}`);
  process.exit(1);
});
