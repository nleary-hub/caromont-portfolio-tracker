import { AdminGate } from "@/lib/auth/AdminGate";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { DateOnly } from "@/lib/domain/DateOnly";
import { ExportService } from "@/lib/import/ExportService";

/** Admin-only CSV export (id + template columns) of non-archived projects (404 for everyone else). */
export async function GET(): Promise<Response> {
  const viewer = await AdminGate.requireAdminViewer();
  // The admin's active service line only.
  const scope = await ServiceLineAccess.activeOrDefault(viewer);
  const { csv } = await ExportService.exportCsv(undefined, scope);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${ExportService.fileName(DateOnly.today())}"`,
      "Cache-Control": "no-store",
    },
  });
}
