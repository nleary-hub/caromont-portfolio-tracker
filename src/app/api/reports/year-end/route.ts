import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import { Db } from "@/lib/db/Db";
import { YearEndOnDemand } from "@/lib/report/YearEndOnDemand";
import { YearEndCategories } from "@/lib/report/YearEndReportData";

// "Generate year-end report" (report.yearEnd.onDemand): live build, direct download, nothing kept. Without the
// permission, without line access or with a bad fiscal year: the same 404 as any unknown address.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  const viewer = await CurrentViewer.get();
  if (!viewer || !YearEndOnDemand.can(viewer) || !Db.isConfigured()) return notFound();
  const url = new URL(request.url);
  const raw = url.searchParams.get("categories");
  const categories = raw === null ? [...YearEndCategories.ALL] : YearEndCategories.parse(raw.split(",").filter(Boolean));
  if (!categories) return notFound();
  const scope = await ServiceLineAccess.activeOrNull(viewer);
  if (!scope) return notFound();
  const pdf = await YearEndOnDemand.render(viewer, url.searchParams.get("fy") ?? "", scope, Db.client, new Date(), categories);
  if (!pdf) return notFound();
  // Audit (Admin > Recent changes): who, when, which fiscal year and the permission. A failed write serves no PDF.
  await YearEndOnDemand.record(viewer, scope, pdf, Db.client);
  return new Response(new Uint8Array(pdf.bytes), {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(pdf.bytes.byteLength),
      "Content-Disposition": `attachment; filename="${pdf.fileName.replace(/[^\w.-]/g, "_")}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function notFound(): Response {
  return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
}
