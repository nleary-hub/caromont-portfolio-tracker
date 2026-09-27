import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import { ReportHttp } from "@/lib/report/ReportHttp";
import { DraftReportService } from "@/lib/services/DraftReportService";
import { OnDemandPdfLink } from "@/lib/report/OnDemandPdfLink";

// "Generate PDF now": live-data draft, download only. Anyone with access to the line gets the departments they are
// viewing (?departments=, their dashboard filter), clamped to ones they can see. An admin viewing every department
// gets the admin report setting, as before. No access to the line = 404.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const draft = await DraftReportService.render(await CurrentViewer.get(), undefined, undefined, undefined, OnDemandPdfLink.parse(request.url));
  if (!draft) return ReportHttp.notFound();
  return ReportHttp.file(draft.bytes, "application/pdf", draft.fileName, "attachment");
}
