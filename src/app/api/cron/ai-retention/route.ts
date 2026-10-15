import { NextResponse } from "next/server";
import { Db } from "@/lib/db/Db";
import { ReportHttp } from "@/lib/report/ReportHttp";
import { AiRetentionService, type AiRetentionDb } from "@/lib/services/AiRetentionService";

// Vercel Cron calls this daily with GET and "Authorization: Bearer $CRON_SECRET" (same check as the freeze cron).
// It clears suggestedText and userEmail on ai_usage_log rows older than 30 days. Separate from /api/cron/freeze: it
// neither imports nor is imported by the freeze route. Manual run:
// curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/cron/ai-retention
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

class CronAiRetentionRoute {
  static async handle(request: Request): Promise<Response> {
    if (!ReportHttp.cronAuthorized(request.headers.get("authorization"))) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!Db.isConfigured()) return NextResponse.json({ error: "Database not configured" }, { status: 500 });
    try {
      const r = await AiRetentionService.run(Db.client as unknown as AiRetentionDb);
      return NextResponse.json({ outcome: "ok", scrubbed: r.scrubbed, cutoff: r.cutoff });
    } catch (e) {
      console.error("ai-retention failed", (e as Error)?.name);
      return NextResponse.json({ error: "AI retention failed. See logs." }, { status: 500 });
    }
  }
}

export async function GET(request: Request) {
  return CronAiRetentionRoute.handle(request);
}

export async function POST(request: Request) {
  return CronAiRetentionRoute.handle(request);
}
