import { ReportHttp } from "@/lib/report/ReportHttp";
import { ReportArchiveService } from "@/lib/services/ReportArchiveService";

// Signed fallback link: serves a frozen report's PDF or handoff.json without app sign-in until the
// token expires (7 days). Excluded from the auth proxy. Vercel Deployment Protection still applies
// in front of the app, see docs/REPORTS.md.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, ctx: { params: Promise<{ token: string; file: string }> }) {
  const { token, file } = await ctx.params;
  if (file !== "pdf" && file !== "handoff") return ReportHttp.notFound();
  const artifact = await ReportArchiveService.shared(token, file);
  if (!artifact) return ReportHttp.notFound();
  return ReportHttp.artifact(artifact, file === "pdf" ? "inline" : "attachment");
}
