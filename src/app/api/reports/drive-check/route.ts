import { OwnerGate } from "@/lib/auth/OwnerGate";
import { ReportHttp } from "@/lib/report/ReportHttp";
import { DriveCheckService } from "@/lib/services/DriveCheckService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Owner-only Drive check (report.freeze). Everyone else gets the generic 404 (L2, L4). POST only. */
export async function POST(): Promise<Response> {
  const viewer = await OwnerGate.ownerViewer();
  if (!viewer) return ReportHttp.notFound();
  const result = await DriveCheckService.run();
  return Response.json(result, { headers: { "Cache-Control": "no-store" } });
}
