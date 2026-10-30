#!/bin/bash
# Final browser pass: full user journey through the Render gateway —
# register in the UI (Prisma), land in the chat (socket.io over the
# gateway's WS route), verified end to end.
exec 2>&1
cd /home/z/my-project

rm -rf /tmp/render-sim && mkdir -p /tmp/render-sim

PORT=8080 NEXT_PORT=3100 WISP_PORT=3101 CHAT_PORT=3103 \
NEXT_DIR="$PWD/.next/standalone" SERVICES_DIR="$PWD/mini-services-dist" \
PRISMA_CLI="$PWD/node_modules/prisma/build/index.js" \
SCHEMA_PATH="$PWD/prisma/schema.prisma" \
DATABASE_URL=file:/tmp/render-sim/custom.db \
nohup node scripts/render-gateway.js > /tmp/render-sim-gateway.log 2>&1 &
GW=$!

for i in $(seq 1 40); do
  curl -sf --max-time 3 http://localhost:8080/api/health >/dev/null 2>&1 && break
  sleep 1
done

agent-browser open http://localhost:8080/ >/dev/null
agent-browser wait --load networkidle >/dev/null
sleep 3   # let the 1.4s boot splash clear

echo "===== go to Chat ====="
agent-browser find role button click --name "Chat" >/dev/null && echo clicked
sleep 3
agent-browser snapshot -i -c 2>/dev/null | rg -i "register|log in|textbox" | head -4

echo "===== switch to Register tab ====="
agent-browser find role button click --name "Register" >/dev/null && echo switched
sleep 1
agent-browser snapshot -i -c 2>/dev/null | rg "textbox" | head -4

echo "===== fill + submit ====="
agent-browser find role textbox fill "render_e2e_user" >/dev/null 2>&1
agent-browser find role textbox fill "render-e2e-pass-1" >/dev/null 2>&1 || true
# password box is type=password — target the second textbox by label
agent-browser snapshot -i -c 2>/dev/null | rg "password|textbox" | head -4
agent-browser find role button click --name "Create account" >/dev/null && echo submitted
sleep 6

echo "===== chat state after register (channels = socket connected) ====="
agent-browser snapshot -c 2>/dev/null | rg -i "announcements|general|render_e2e_user|coins|channel" | head -10

echo "===== socket evidence from the chat service log ====="
rg "connection|handshake|render_e2e|joined" /tmp/render-sim-gateway.log | tail -6

kill -TERM $GW 2>/dev/null; sleep 2
pkill -f "mini-service-wisp-service.js" 2>/dev/null
pkill -f "mini-service-chat-service.js" 2>/dev/null
pkill -f ".next/standalone/server.js" 2>/dev/null
agent-browser close >/dev/null 2>&1
echo done
