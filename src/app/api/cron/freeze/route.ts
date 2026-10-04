import { NextResponse } from "next/server";
import { ReportHttp } from "@/lib/report/ReportHttp";
import { ReportLog } from "@/lib/report/ReportLog";
import { StoredPdfCopy, StoredPdfMissingError } from "@/lib/report/StoredPdf";
import { FreezeService } from "@/lib/services/FreezeService";

// Vercel Cron calls this with GET and "Authorization: Bearer $CRON_SECRET". It runs daily; the
// code decides whether a freeze is due (biweekly, Tuesdays at 5 PM ET). POST works the same for a
// manual backstop: curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/cron/freeze
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

class CronFreezeRoute {
  static async handle(request: Request): Promise<Response> {
    if (!ReportHttp.cronAuthorized(request.headers.get("authorization"))) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    try {
      const result = await FreezeService.run({ trigger: "cron", actor: "cron" });
      return NextResponse.json({
        outcome: result.outcome,
        message: result.message,
        period: result.period ?? null,
        snapshotId: result.snapshotId ?? null,
        delivery: result.delivery?.status ?? null,
      });
    } catch (e) {
      ReportLog.error("freeze.failed", { error: e instanceof Error ? e.message : String(e) });
      if (e instanceof StoredPdfMissingError) return NextResponse.json({ error: StoredPdfCopy.TITLE, message: StoredPdfCopy.message(StoredPdfCopy.frozenOn(e.generatedAt)), snapshotId: e.snapshotId }, { status: 500 });
      return NextResponse.json({ error: "Freeze failed. See logs." }, { status: 500 });
    }
  }
}

export async function GET(request: Request) {
  return CronFreezeRoute.handle(request);
}

export async function POST(request: Request) {
  return CronFreezeRoute.handle(request);
}
