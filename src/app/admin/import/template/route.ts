import { AdminGate } from "@/lib/auth/AdminGate";
import { ProjectCsv } from "@/lib/import/ProjectCsv";

/** Admin-only download of the project import template (404 for everyone else). */
export async function GET(): Promise<Response> {
  await AdminGate.requireAdmin();
  return new Response(ProjectCsv.templateCsv(), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="project-import-template.csv"',
      "Cache-Control": "no-store",
    },
  });
}
