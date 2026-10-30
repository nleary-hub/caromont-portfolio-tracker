import { NextResponse } from "next/server";
import { Db } from "@/lib/db/Db";
import { ReportHttp } from "@/lib/report/ReportHttp";
import { AiProviderKeyAccess } from "@/lib/services/AiFeatureProviderService";
import { AiModelListRefreshService, type AiListFetch, type AiModelListDb } from "@/lib/services/AiModelListRefreshService";
import type { AiRegistryDb } from "@/lib/services/AiRegistryService";

// Vercel Cron calls this daily with GET and "Authorization: Bearer $CRON_SECRET" (same constant-time check as the other
// crons; CRON_SECRET unset refuses every call). It refreshes the model list of every provider with a saved key and writes
// the cache and listedState only. It never adds, enables, disables, archives or reassigns a model. It imports nothing from
// the freeze route. A provider attempted in the last 20 hours is skipped, so a second run makes no provider call.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

class CronAiModelListsRoute {
  static async handle(request: Request): Promise<Response> {
    if (!ReportHttp.cronAuthorized(request.headers.get("authorization"))) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    if (!Db.isConfigured()) return NextResponse.json({ error: "Database not configured" }, { status: 500 });
    try {
      const db = Db.client as unknown;
      const keys = AiProviderKeyAccess.source(db, process.env);
      const outcomes = await AiModelListRefreshService.runCron({
        db: db as AiModelListDb,
        registry: db as AiRegistryDb,
        savedProviders: () => AiProviderKeyAccess.savedProviders(db),
        secret: (p) => keys.secret(p),
        fetch: fetch as unknown as AiListFetch,
      });
      return NextResponse.json({ outcome: "ok", providers: outcomes.map((o) => ({ provider: o.provider, result: o.result })) });
    } catch (e) {
      console.error("ai-model-lists failed", (e as Error)?.name);
      return NextResponse.json({ error: "Model list refresh failed. See logs." }, { status: 500 });
    }
  }
}

export async function GET(request: Request) {
  return CronAiModelListsRoute.handle(request);
}

export async function POST(request: Request) {
  return CronAiModelListsRoute.handle(request);
}
