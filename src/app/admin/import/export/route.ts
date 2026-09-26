import { AdminGate } from "@/lib/auth/AdminGate";
import { DateOnly } from "@/lib/domain/DateOnly";
import { ExportService } from "@/lib/import/ExportService";

/** Admin-only CSV export (id + template columns) of non-archived projects (404 for everyone else). */
export async function GET(): Promise<Response> {
  await AdminGate.requireAdmin();
  const { csv } = await ExportService.exportCsv();
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${ExportService.fileName(DateOnly.today())}"`,
      "Cache-Control": "no-store",
    },
  });
}
