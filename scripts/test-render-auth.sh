#!/bin/bash
# Focused check: Next API + Prisma + fresh SQLite through the gateway
# (register → login → session), plus a raw look at the DB rows.
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

echo "===== register (POST /api/auth/register) ====="
curl -s --max-time 20 -X POST http://localhost:8080/api/auth/register \
  -H "content-type: application/json" \
  -d '{"username":"render_sim_user","password":"render-sim-pass-1"}' | head -c 220
echo; echo "===== login ====="
curl -s --max-time 20 -X POST http://localhost:8080/api/auth/login \
  -H "content-type: application/json" \
  -d '{"username":"render_sim_user","password":"render-sim-pass-1"}' | head -c 220
echo; echo "===== me (session token) ====="
TOKEN=$(curl -s --max-time 20 -X POST http://localhost:8080/api/auth/login \
  -H "content-type: application/json" \
  -d '{"username":"render_sim_user","password":"render-sim-pass-1"}' | python3 -c "import json,sys; print(json.load(sys.stdin)['token'])")
curl -s --max-time 20 http://localhost:8080/api/auth/me -H "authorization: Bearer $TOKEN" | head -c 200
echo; echo "===== rows in the fresh SQLite ====="
python3 - <<'EOF'
import sqlite3
con = sqlite3.connect('/tmp/render-sim/custom.db')
users = list(con.execute("select username, role, coins, xp from User"))
sessions = list(con.execute("select count(*) from Session"))
channels = list(con.execute("select name from Channel limit 5"))
print("users:", users)
print("sessions:", sessions[0][0])
print("channels (seeded by chat svc):", [c[0] for c in channels])
EOF

echo "===== SSE smoke (AI route without credentials must fail gracefully, not hang) ====="
timeout 25 curl -s --max-time 20 -N -X POST http://localhost:8080/api/ai/chat \
  -H "content-type: application/json" \
  -H "authorization: Bearer $TOKEN" \
  -d '{"messages":[{"role":"user","content":"hi"}]}' | head -c 200
echo; echo "===== gateway log tail ====="
rg -v "^\[wisp\]|^\[next\]" /tmp/render-sim-gateway.log | tail -12

kill -TERM $GW 2>/dev/null; sleep 2
pkill -f "mini-service-wisp-service.js" 2>/dev/null
pkill -f "mini-service-chat-service.js" 2>/dev/null
pkill -f ".next/standalone/server.js" 2>/dev/null
echo "done"
