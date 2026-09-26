import { redirect } from "next/navigation";
import { auth, signOut, SIGN_IN_PATH } from "@/auth";
import { ProjectDashboard, type LatestReport } from "@/components/ProjectDashboard";
import { SignInPolicy } from "@/lib/auth/SignInPolicy";
import { DashboardViewModel, type DashboardRow } from "@/lib/dashboard/DashboardViewModel";
import { Db } from "@/lib/db/Db";
import { DateOnly } from "@/lib/domain/DateOnly";

class DashboardData {
  static async load(today: string): Promise<{ rows: DashboardRow[]; latestReport: LatestReport | null; error: string | null }> {
    if (!Db.isConfigured()) return { rows: [], latestReport: null, error: "DATABASE_URL is not configured." };
    try {
      const db = Db.client;
      const [projects, latest] = await Promise.all([
        db.project.findMany({ where: { archivedAt: null } }),
        db.reportSnapshot.findFirst({
          orderBy: { generatedAt: "desc" },
          select: { generatedAt: true, periodStart: true, periodEnd: true },
        }),
      ]);
      const history = await db.projectHistory.findMany({
        where: {
          projectId: { in: projects.map((p) => p.id) },
          ...(latest ? { changedAt: { gt: latest.generatedAt } } : {}),
        },
        select: { projectId: true, changedAt: true },
        distinct: ["projectId"],
      });
      return {
        rows: DashboardViewModel.rows(projects, history, latest?.generatedAt ?? null, today),
        latestReport: latest
          ? {
              reportDate: DateOnly.inZone(latest.generatedAt),
              periodStart: DateOnly.fromDbDate(latest.periodStart)!,
              periodEnd: DateOnly.fromDbDate(latest.periodEnd)!,
            }
          : null,
        error: null,
      };
    } catch (e) {
      console.error("Failed to load projects", e);
      return { rows: [], latestReport: null, error: "Could not load projects from the database." };
    }
  }
}

export default async function DashboardPage() {
  // Defense in depth: the proxy already gates this route.
  const session = await auth();
  const email = session?.user?.email;
  if (!email || !SignInPolicy.canAccess(email)) redirect(SIGN_IN_PATH);

  const today = DateOnly.today();
  const { rows, latestReport, error } = await DashboardData.load(today);

  return (
    <ProjectDashboard
      rows={rows}
      today={today}
      userEmail={email}
      userName={session?.user?.name ?? null}
      latestReport={latestReport}
      loadError={error}
      signOutAction={async () => {
        "use server";
        await signOut({ redirectTo: SIGN_IN_PATH });
      }}
    />
  );
}
