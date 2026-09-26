import { redirect } from "next/navigation";
import { auth, signOut, SIGN_IN_PATH } from "@/auth";
import { ProjectDashboard, type LatestReport } from "@/components/ProjectDashboard";
import { EmailAllowlist } from "@/lib/auth/EmailAllowlist";
import { DashboardViewModel, type DashboardRow } from "@/lib/dashboard/DashboardViewModel";
import { Db } from "@/lib/db/Db";
import { DateOnly } from "@/lib/domain/DateOnly";
import { ViewSettings, type ViewSettingsByContext } from "@/lib/domain/ViewSettings";
import { ViewSettingsService } from "@/lib/services/ViewSettingsService";
import { saveViewSettings } from "@/app/actions/viewSettings";

class DashboardData {
  static defaultSettings(): ViewSettingsByContext {
    return { dashboard: ViewSettings.defaults("dashboard"), report: ViewSettings.defaults("report") };
  }

  static async load(today: string): Promise<{
    rows: DashboardRow[];
    latestReport: LatestReport | null;
    viewSettings: ViewSettingsByContext;
    error: string | null;
  }> {
    if (!Db.isConfigured()) {
      return { rows: [], latestReport: null, viewSettings: DashboardData.defaultSettings(), error: "DATABASE_URL is not configured." };
    }
    try {
      const db = Db.client;
      const [projects, latest, viewSettings] = await Promise.all([
        db.project.findMany({ where: { archivedAt: null } }),
        db.reportSnapshot.findFirst({
          orderBy: { generatedAt: "desc" },
          select: { generatedAt: true, periodStart: true, periodEnd: true },
        }),
        ViewSettingsService.getAll(db),
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
        viewSettings,
        error: null,
      };
    } catch (e) {
      console.error("Failed to load projects", e);
      return {
        rows: [],
        latestReport: null,
        viewSettings: DashboardData.defaultSettings(),
        error: "Could not load projects from the database.",
      };
    }
  }
}

export default async function DashboardPage() {
  // Defense in depth: the proxy already gates this route.
  const session = await auth();
  const email = session?.user?.email;
  if (!email || !EmailAllowlist.isAllowed(email)) redirect(SIGN_IN_PATH);

  const today = DateOnly.today();
  const { rows, latestReport, viewSettings, error } = await DashboardData.load(today);

  return (
    <ProjectDashboard
      rows={rows}
      today={today}
      userEmail={email}
      userName={session?.user?.name ?? null}
      latestReport={latestReport}
      loadError={error}
      viewSettings={viewSettings}
      saveViewSettingsAction={async (context, value) => {
        "use server";
        const result = await saveViewSettings(context, value);
        return result.ok ? null : result.error;
      }}
      signOutAction={async () => {
        "use server";
        await signOut({ redirectTo: SIGN_IN_PATH });
      }}
    />
  );
}
