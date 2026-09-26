import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import { ReportHttp } from "@/lib/report/ReportHttp";
import { DraftReportService } from "@/lib/services/DraftReportService";

// Admin "Generate PDF now": live-data draft, download only. Non-admins get 404.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  const draft = await DraftReportService.render(await CurrentViewer.get());
  if (!draft) return ReportHttp.notFound();
  return ReportHttp.file(draft.bytes, "application/pdf", draft.fileName, "attachment");
}
