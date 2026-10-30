import { NextResponse } from "next/server";

/* Render (and the render-gateway supervisor) use this as the health
   check. It must stay dependency-free and instant — no DB, no
   upstream pings — so a slow child service can never fail the
   platform health check and trigger a restart loop. */
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ ok: true, app: "memphis-unblacked" });
}
