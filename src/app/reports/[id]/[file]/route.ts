import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import { ReportHttp } from "@/lib/report/ReportHttp";
import { ReportArchiveService } from "@/lib/services/ReportArchiveService";

// Archive downloads (signed in via the proxy). handoff.json is admin-only.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, ctx: { params: Promise<{ id: string; file: string }> }) {
  const viewer = await CurrentViewer.get();
  const { id, file } = await ctx.params;
  if (!viewer || (file !== "pdf" && file !== "handoff")) return ReportHttp.notFound();
  // Per-line access: only the viewer's active line (one they may use); no line at all = 404.
  const scope = await ServiceLineAccess.activeOrNull(viewer);
  if (!scope) return ReportHttp.notFound();
  const artifact = await ReportArchiveService.file(viewer, id, file, undefined, scope);
  if (artifact) return ReportHttp.artifact(artifact);
  const missing = file === "pdf" ? await ReportArchiveService.storedPdfMissing(id, undefined, scope) : null;
  return missing ? ReportHttp.storedPdfMissing(missing.generatedAt) : ReportHttp.notFound();
}
