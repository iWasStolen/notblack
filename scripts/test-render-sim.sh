#!/bin/bash
# ============================================================
# Local simulation of the Render.com topology — proves the Docker
# image's process graph before it ever reaches Render:
#
#   gateway :8080 → next :3100 (standalone, node)
#                → wisp  :3101 (bundled, bun)
#                → chat  :3103 (bundled, bun)
#   fresh SQLite at /tmp/render-sim/custom.db
#
# Covers: health check, HTTP proxying, socket.io polling route,
# WS upgrade routes (wisp + chat), UI register (Prisma), chat
# channel list via the socket, proxied page load through wisp.
# Everything runs inside one invocation — the sandbox reaps
# background processes between tool calls.
# ============================================================
exec 2>&1
cd /home/z/my-project

echo "===== 0. fresh sim database ====="
rm -rf /tmp/render-sim
mkdir -p /tmp/render-sim

echo "===== 1. boot gateway ====="
PORT=8080 NEXT_PORT=3100 WISP_PORT=3101 CHAT_PORT=3103 \
NEXT_DIR="$PWD/.next/standalone" SERVICES_DIR="$PWD/mini-services-dist" \
PRISMA_CLI="$PWD/node_modules/prisma/build/index.js" \
SCHEMA_PATH="$PWD/prisma/schema.prisma" \
DATABASE_URL=file:/tmp/render-sim/custom.db \
nohup node scripts/render-gateway.js > /tmp/render-sim-gateway.log 2>&1 &
GW=$!
echo "gateway pid $GW"

for i in $(seq 1 40); do
  curl -sf --max-time 3 http://localhost:8080/api/health >/dev/null 2>&1 && break
  sleep 1
done

echo "===== 2. health ====="
curl -s --max-time 10 http://localhost:8080/api/health; echo
echo "===== 3. home page ====="
curl -s -o /dev/null -w "status=%{http_code} time=%{time_total}s\n" --max-time 30 http://localhost:8080/
echo "===== 4. games API (Next + Prisma-less path) ====="
curl -s --max-time 20 "http://localhost:8080/api/games?per=2" | head -c 130; echo
echo "===== 5. wisp plain HTTP (wispHealth route) ====="
curl -s --max-time 10 "http://localhost:8080/wisp/?XTransformPort=3001"; echo
echo "===== 6. socket.io polling handshake (chat route) ====="
curl -s --max-time 10 "http://localhost:8080/?EIO=4&transport=polling&XTransformPort=3003&t=render-sim" | head -c 80; echo
echo "===== 7. WS upgrade → wisp ====="
curl -s -i --max-time 10 \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" -H "Sec-WebSocket-Version: 13" \
  "http://localhost:8080/wisp/?XTransformPort=3001&/" | head -3
echo "===== 8. WS upgrade → chat (socket.io) ====="
curl -s -i --max-time 10 \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" -H "Sec-WebSocket-Version: 13" \
  "http://localhost:8080/socket.io/?EIO=4&transport=websocket&XTransformPort=3003" | head -3

echo "===== 9. browser E2E ====="
agent-browser open http://localhost:8080/ >/dev/null
agent-browser wait --load networkidle >/dev/null
echo "lang: $(agent-browser eval 'document.documentElement.lang' | tail -1)"
agent-browser find role button click --name "Chat" >/dev/null
sleep 4
agent-browser snapshot -i -c 2>/dev/null | rg -i "log in|register|username|textbox" | head -6

echo "---- switch to register mode ----"
agent-browser find role button click --name "Register" >/dev/null 2>&1 || true
sleep 1
agent-browser snapshot -i -c 2>/dev/null | rg -i "textbox|button" | head -8

echo "===== 10. register a user ====="
agent-browser find label "Username" fill "render_sim_user" >/dev/null 2>&1 \
  || agent-browser find role textbox fill "render_sim_user" >/dev/null 2>&1
agent-browser find label "Password" fill "render-sim-pass-1" >/dev/null 2>&1
agent-browser find role button click --name "Create account" >/dev/null 2>&1
sleep 5
agent-browser snapshot -c 2>/dev/null | rg -i "announcements|general|render_sim_user|connected|coins" | head -8

echo "===== 11. proxied page through wisp (Browse) ====="
agent-browser find role button click --name "Browse" >/dev/null
sleep 3
agent-browser snapshot -i -c 2>/dev/null | rg "textbox" | head -2
AB=$(agent-browser snapshot -i -c 2>/dev/null | rg -o '@e[0-9]+' | head -1)
echo "address bar ref: $AB"
agent-browser find role textbox fill "httpbin.org/headers" >/dev/null 2>&1
agent-browser press Enter >/dev/null
sleep 25
agent-browser eval "(() => { const f = document.querySelector('iframe'); if (!f) return 'no iframe'; try { return (f.contentDocument?.body?.innerText || '(empty)').slice(0, 260); } catch { return 'x-origin'; } })()" 2>/dev/null | tail -2

echo "===== 12. gateway log ====="
tail -30 /tmp/render-sim-gateway.log

echo "===== 13. shutdown ====="
kill -TERM $GW 2>/dev/null
sleep 3
pkill -f "mini-service-wisp-service.js" 2>/dev/null
pkill -f "mini-service-chat-service.js" 2>/dev/null
pkill -f ".next/standalone/server.js" 2>/dev/null
agent-browser close >/dev/null 2>&1
echo "done"
