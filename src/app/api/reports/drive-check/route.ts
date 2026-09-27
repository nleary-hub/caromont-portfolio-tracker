import { AdminGate } from "@/lib/auth/AdminGate";
import { DriveCheckService } from "@/lib/services/DriveCheckService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Admin-only Drive check (Admin > Report freeze > Check Drive). Everyone else gets 403. POST only. */
export async function POST(): Promise<Response> {
  const viewer = await AdminGate.adminViewer();
  if (!viewer) return Response.json({ ok: false, message: "Not authorized." }, { status: 403, headers: { "Cache-Control": "no-store" } });
  const result = await DriveCheckService.run();
  return Response.json(result, { headers: { "Cache-Control": "no-store" } });
}
