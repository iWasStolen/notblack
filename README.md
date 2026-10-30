# Memphis unBLACKed

A full-stack, monochrome (pure black & white) web app — 1,600+ verified
playable games, 50 day-use apps, Spotify and YouTube through a self-hosted
**Scramjet v2** web proxy, a free unlimited **GLM** AI chat, and a live
community chat.

> Single-page app at `/` with eight sections: **Home · Play · Apps · Chat · AI ·
> Listen · Watch · Browse**.

---

## Stack

| Layer | Choice |
| --- | --- |
| Framework | Next.js 16 (App Router) + React 19 + TypeScript |
| Styling | Tailwind CSS 4 + shadcn/ui (New York) + Lucide icons |
| State | Zustand (client) · localStorage persistence |
| Database | Prisma ORM + SQLite (`db/custom.db`) |
| Realtime | Socket.io mini-service (`mini-services/chat-service`, port 3003) |
| Proxy engine | Scramjet **2.0.67-alpha.2** + scramjet-controller 0.0.14 + scramjet-utils 0.0.3 |
| Transports | epoxy-transport 3.0.2 (default) · libcurl-transport 2.0.6 |
| Relay | Self-hosted wisp server (`mini-services/wisp-service`, port 3001) |
| AI | GLM (glm-4-plus) via `z-ai-web-dev-sdk`, server-side only, streaming SSE |
| Games | 62 hand-curated games (official sites, Scratch, GitHub Pages, KBHgames) + 106 tung tung reference picks (Minecraft versions, Vex, FNF mods — jsDelivr + reference CDN, verified) + 1,350 GameFlare most-played (verified embeds) + 12 built-ins |

## Architecture

```
Browser
  └─ Memphis SPA (Next.js, port 3000)
       ├─ /sw.js — routes /~/sj/<controller>/<frame>/* requests
       │    into the page-side Controller over a MessageChannel RPC
       ├─ /scram2/scramjet.js + scramjet.wasm   (core rewriter)
       ├─ /controller/controller.{api,sw,inject}.js
       ├─ /utils/scramjet-utils.js               (plugins)
       ├─ /epoxy/index.mjs · /libcurl/index.mjs  (transports, in-page)
       │    └─ WebSocket → wisp relay (port 3001) → target site
       ├─ /api/games    — 3,500+-game catalog (search / categories / ids)
       ├─ /api/ai/*     — GLM chat (streaming SSE, no auth, no limits):
       │    Fast/Reasoning modes, any-file attachments, vision, web search
       │    with citations, image gen/edit, voice in/out, FILE COMPOSITION
       │    (real .xlsx/.docx/.pptx/.pdf/code/data files, live composing
       │    view, preview + download cards), regenerate/edit/rename,
       │    follow-up suggestions — all session-scoped
       ├─ /api/games/scores, /api/auth/*, /api/reports
       └─ chat-service  — socket.io community chat (port 3003)
```

- **Scramjet v2 architecture**: no bare-mux, no SharedWorker. The transport
  object lives in the page and the service worker routes proxied requests
  back to it via a `$controller$init` MessageChannel handshake. Per-frame
  URL prefixes (`/~/sj/<controller>/<frame>/…`) drive routing.
- **Vendored proxy assets** live in `public/`: `scram2/` (core + wasm),
  `controller/`, `utils/`, `epoxy/`, `libcurl/`, and `sw.js`. The v1 tree
  (`scram/`, `baremux/`) is gone. Version-lock: the controller asserts the
  core version at construction — always vendor matching builds together.
- **URL encoding without a public encodeUrl**: v2 has none, so the app
  pools *detached* encoder frames (`proxiedHref()` in
  `src/lib/scramjet.ts`). `frame.go(url)` sets the encoded `element.src`,
  and because routing is URL-prefix based (not element based), those
  hrefs work in any iframe while the page's controller stays alive.
- **Browser-compat shim** (`public/sharedworker-shim.js`, loaded first and
  blocking): keeps an in-memory `localStorage` when the browser blocks
  storage (managed Chromebooks). The SharedWorker polyfill is retained for
  safety but v2 no longer needs it — transports run in the page.
- **Boot order** (`src/lib/scramjet.ts`): register `/sw.js` and wait for a
  controlling worker → self-heal the `__scramjet_controller` IndexedDB →
  load core → controller API → utils → instantiate the transport (epoxy or
  libcurl, eagerly `init()`ed against wisp) → `new Controller({serviceworker,
  transport, config})` → `await controller.wait()` → 15s keepalive pings
  (the SW must stay alive to route). Plain-language staged errors
  (engine vs transport) with a diagnostics line and in-place Retry.
- **No COOP/COEP headers** (`next.config.ts`): v1 needed cross-origin
  isolation for SharedArrayBuffer in its SharedWorker transports; v2 does
  not, and the headers actively *blocked* direct game embeds like
  classic.minecraft.net. Proxied content manages its own headers.
- **The wisp URL** is computed at runtime as
  `ws(s)://<host>/wisp/?XTransformPort=3001&/` — the trailing `&/` is required
  (the wisp server switches to wsproxy mode if the URL does not end in `/`).
- **Transport switching** is live: Settings → Browse → Transport constructs
  a fresh transport and hands it to `controller.setTransport()` — new
  requests use it immediately, no reload.
- **Wisp supervisor**: `scripts/supervise-wisp.sh` keeps the relay alive
  (restarts with backoff if it crashes). Start it once and forget it.

## Getting started

```bash
bun install
bun run db:push          # apply the Prisma schema
node scripts/build-games-catalog.mjs   # (re)build + re-verify data/games.json

# terminal 1 — wisp relay (required for the proxy), supervised
bash scripts/supervise-wisp.sh   # foreground; or nohup it (see script header)
# (equivalent manual run: cd mini-services/wisp-service && bun run start)

# terminal 2 — chat service (required for the Chat tab)
cd mini-services/chat-service && bun install && bun run dev

# terminal 3 — the app
bun run dev              # http://localhost:3000
```

Behind the sandbox gateway, the services are reached with
`?XTransformPort=<port>` query params (see `Caddyfile`):
`/wisp/?XTransformPort=3001&/` (relay) and `/?XTransformPort=3003` (chat).

## Environment variables

`DATABASE_URL` — SQLite connection string (default `file:../db/custom.db` in
`src/lib/db.ts`). No other secrets are required: the AI runs on the built-in
GLM SDK.

## Feature inventory

- **Play** — 1,600+ playable games: the 62 hand-verified classics
  (Minecraft Classic, Paper Minecraft, Krunker, Shell Shockers, Slither,
  Diep, Smash Karts, Skribbl, Retro Bowl, Slope, Run 3, Tunnel Rush,
  Moto X3M, FNF, Cookie Clicker, Happy Wheels, Baldi's Basics …) plus
  106 popular picks from the tung tung reference catalog (Minecraft
  1.5–1.21, Geometry Dash, the full Vex series, FNAF: Sisters Location,
  Drive Mad, Subway Surfers, BitLife, Among Us, 19 iconic FNF mods,
  Duck Life, Riddle School, Fireboy & Watergirl …) plus the
  1,350 most-played games from GameFlare — FNAF, Papa's, Sprunki, Bloons
  TD, Getaway Shootout, Rooftop Snipers, Whack Your Boss, Learn to Fly,
  Super Smash Flash 2 and hundreds more — every embed verified at build
  time — plus 12 built-in canvas classics with server-side leaderboards.
  Search, 20+ category filters, A–Z sorting, favorites & recents
  (localStorage), infinite scroll, fullscreen player with a "load via
  proxy" fallback for stubborn embeds and a srcdoc renderer for
  jsDelivr-hosted games (served as text/plain).
- **Apps** — exactly 50 day-use apps (YouTube, Instagram, TikTok, ChatGPT,
  Gemini, Snapchat, Discord, Netflix, Gmail, Maps, Roblox, …), each opened
  through the Scramjet proxy in the built-in browser.
- **Chat** — full community chat: accounts, channels, DMs, friends, polls,
  moderation, XP/coins, soundboard (socket.io mini-service).
- **AI** — real GLM chat: streaming answers, markdown + code highlighting,
  custom instructions, saved conversations (anonymous per-browser sessions),
  flashcard generator. No sign-in, no quota, no rate limits.
- **Listen** — the full Spotify web player through the proxy.
- **Watch** — all of YouTube through the proxy (trending, subscriptions,
  history, quick links).
- **Browse** — tabbed Scramjet browser: address bar with engine choice
  (DuckDuckGo/Google/Bing/Brave), history, reload, proxied new-tab,
  fullscreen, live engine status.
- **Settings** — appearance (monochrome variants), tab cloak, about:blank
  launcher, panic hotkey, close protection, proxy transport (epoxy/libcurl),
  search engine, local data management.

## Services & ports

| Port | Service |
| --- | --- |
| 3000 | Next.js app (gateway default) |
| 3001 | wisp relay (`mini-services/wisp-service`) |
| 3003 | chat service (`mini-services/chat-service`) |

## Data sources

- Games: three-layer catalog, **live-verified at build time** —
  1. the hand-curated classics (official game sites, Scratch `/embed`
     endpoints, GitHub Pages / jsDelivr open-source classics, KBHgames),
     kept in `scripts/build-games-catalog.mjs` history and preserved at
     the top of the catalog; and
  2. the tung tung reference picks: `scripts/merge-tungtung-games.mjs`
     pulls the reference site's six public game lists (gn-math, seraph,
     hydra/3kh0 on jsDelivr, ports, tglsc), adds a curated 106-game
     popular subset with per-game source overrides for broken uploads,
     and verifies every embed (headers + content-type). jsDelivr games
     are rendered through the player's srcdoc mode (fetch + `<base>`
     inject) because jsDelivr serves `.html` as text/plain; and
  3. the GameFlare most-played catalog: `scripts/fetch-gameflare-listing.mjs`
     scrapes all ~274 GameFlare category listings (popularity, franchise and
     genre pages) into `data/gameflare-listing.json`, then
     `scripts/build-games-catalog.mjs` ranks candidates by play count,
     dedupes against the curated set, maps categories onto the Memphis
     taxonomy, and verifies every embed URL (HTTP 200, no frame-blocking
     headers). Anything dead is dropped automatically.
  Regenerate with `node scripts/fetch-gameflare-listing.mjs && node
  scripts/build-games-catalog.mjs` (GameFlare layer) or `node
  scripts/merge-tungtung-games.mjs` (tung tung layer; idempotent —
  re-running rebuilds the tt- batch from the wants list).
- Thumbnails: GameFlare's CDN (`data.gameflare.com`) for catalog games,
  Google's public favicon service for the curated classics.
- Proxy stack: Mercury Workshop's Scramjet / epoxy-transport /
  libcurl-transport / wisp-js (vendored dist files, AGPL — see `public/*/`).

## Troubleshooting — "Proxy engine failed to start"

The error screen tells you which stage failed and shows a diagnostics line
like `Chrome · https:y · SW:y · ctl:y · SharedWorker:y · storage:y · engine:y`.
When the ServiceWorker API itself is missing (`SW:n`), the screen swaps the
generic error for platform-correct recovery steps (see `src/lib/proxy-guidance.ts`).

| Symptom / diagnostics | Cause | Fix |
| --- | --- | --- |
| `SW:n` (no ServiceWorker API at all) | The browsing context hides it: iPhone/iPad in-app browsers (links opened inside chat/social apps), Safari Private Browsing, or a plain-HTTP address | Follow the numbered steps on the error screen: on iOS use “Open in Safari” from the Share menu / a normal (non-private) window; elsewhere open the **HTTPS version** button or use Chrome/Edge/Firefox |
| `https:n` | Page loaded over plain HTTP | Tap **Open HTTPS version** (or copy the link) and reload |
| `storage:n` | Browser blocks site data ("Block all cookies") | Allow site data for this site; an in-memory fallback keeps the session working either way |
| `engine:n` persisting | An extension or filter blocks the engine scripts | Disable the ad-blocker for this site, then press **Retry** (the boot re-injects the scripts) |
| `ctl:y` but pages error | A service worker from an older deployment is stale | Hard refresh; the app re-registers `/sw.js` and reloads itself once on takeover |
| "Proxy transport failed" | The wisp relay is down or a network blocks WebSockets | Check the relay: `curl http://<host>/wisp/?XTransformPort=3001` (expect 200); the supervisor auto-restarts crashes. Try the other transport in Settings |
| A game shows "Just a moment…" | That portal's Cloudflare challenge (KBHgames / Gameflare) | It resolves on its own in a normal browser; headless/automated browsers loop on it |
| A game will not embed | Its server refuses iframes | Use **load via proxy** in the player footer, or **Report it** |

Operational notes:

- The wisp relay is supervised by `scripts/supervise-wisp.sh` (auto-restart
  with backoff, logs to `mini-services/wisp-service/wisp.log`).
- Both transports multiplex through the same relay; switching epoxy ↔
  libcurl in Settings applies live without a reload.
- The service worker caches nothing itself — a hard refresh always picks up
  the newest engine files.
- Proxied tabs opened with "open in new tab (proxied)" are served by the
  originating page's controller — keep the Memphis tab open.

## Deploying on Render.com

The whole stack ships as **one Docker web service** behind a single public
port. A small supervisor — `scripts/render-gateway.js`, PID 1 in the
container — routes traffic and keeps every process alive:

```
Render edge ──▶ :$PORT  render-gateway (node, PID 1)
                  ├── HTTP/WS  everything            ──▶ Next.js standalone (node, :3000)
                  ├── HTTP/WS  ?XTransformPort=3001  ──▶ wisp relay          (bun,   :3001)
                  │   WS       /wisp/*               ──▶ wisp relay
                  └── HTTP/WS  ?XTransformPort=3003  ──▶ chat service        (bun,   :3003)
```

The routing mirrors the sandbox gateway's `XTransformPort` convention, so
**no client URLs change** — the browser still connects to
`wss://<host>/wisp/?XTransformPort=3001&/` and `io("/?XTransformPort=3003")`.

### Files

| File | Purpose |
| --- | --- |
| `render.yaml` | Render blueprint (service, env vars, health check, disk option) |
| `Dockerfile` | Multi-stage build: node:22-slim + bun; bundles the mini-services |
| `.dockerignore` | Keeps user data, secrets and sandbox plumbing out of the image |
| `scripts/render-gateway.js` | PID 1: router + supervisor + boot-time `prisma db push` |

### Deploy

1. Push the clean `deploy` branch to GitHub/GitLab (a private repo is
   fine — Render connects to private repos):

   ```bash
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin deploy
   ```

   `deploy` is a single squashed snapshot commit: the workspace's full
   `main` history (which at some point contained the sandbox's live
   SQLite database and uploads) never leaves the machine. `main` and
   `deploy` now both gitignore `db/`, `upload/`, `.env`,
   `download/`, `tool-results/` and `.zscripts/`.
2. On Render: **New → Blueprint**, point it at the repo — `render.yaml`
   creates the web service (Docker, health check `/api/health`).
3. (Optional, for Memphis AI) set the `ZAI_CONFIG` env var in the Render
   dashboard to `{"baseUrl":"...","apiKey":"..."}` — the gateway writes it
   to `/etc/.z-ai-config` at boot. Without it the app runs fine; AI
   features answer "model unavailable".

### Data persistence

SQLite lives at `DATABASE_URL` (`file:/app/db/custom.db` by default). On
the **free plan the disk is ephemeral** — the database and AI uploads
reset on every deploy/restart, and the instance sleeps after 15 min of
inactivity (cold start ~1 min). For persistence:

1. Upgrade the service to a paid plan (Starter+).
2. Uncomment the `disk:` block in `render.yaml` (1 GB at `/data`).
3. Change `DATABASE_URL` to `file:/data/custom.db` and optionally set
   `UPLOAD_DIR=/data/upload-ai`.

On every boot the gateway runs `prisma db push` against the target file —
fresh volumes get the full schema, and existing databases are migrated to
the current schema automatically.

### Environment variables

| Var | Default | Meaning |
| --- | --- | --- |
| `PORT` | `10000` | Public port (set by Render) |
| `NEXT_PORT` / `WISP_PORT` / `CHAT_PORT` | `3000` / `3001` / `3003` | Internal ports — leave default |
| `DATABASE_URL` | `file:/app/db/custom.db` | SQLite location (put it on the disk for persistence) |
| `ZAI_CONFIG` | – | `{"baseUrl":…,"apiKey":…}` JSON for Memphis AI |
| `UPLOAD_DIR` | `<app>/upload/ai` | Where AI-composed files are stored |

### Verifying the deployment

- `GET /api/health` → `{"ok":true,...}` (also Render's health check)
- Chat tab loads the channel list (socket.io through the gateway)
- Browse loads a site (Scramjet through the wisp relay)

A local simulation of the exact container topology (gateway + standalone
build + bundled services on one port) is re-runnable:
`bash scripts/test-render-sim.sh`.
