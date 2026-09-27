import { DepartmentAccess } from "@/lib/access/DepartmentAccess";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import { ReportHttp } from "@/lib/report/ReportHttp";
import { YearEndReportService } from "@/lib/services/YearEndReportService";

// Stored year-end report PDFs (signed in via the proxy; the viewer's active line only).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const viewer = await CurrentViewer.get();
  if (!viewer) return ReportHttp.notFound();
  const { id } = await ctx.params;
  const scope = await ServiceLineAccess.activeOrNull(viewer);
  // Reports cover every department of the line: a viewer limited to some departments gets none (404).
  if (!scope || DepartmentAccess.isLimited(scope)) return ReportHttp.notFound();
  const file = await YearEndReportService.file(id, scope);
  return file ? ReportHttp.file(file.bytes, file.contentType, file.fileName, "attachment") : ReportHttp.notFound();
}
