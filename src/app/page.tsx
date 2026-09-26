import { redirect } from "next/navigation";
import { signOut, SIGN_IN_PATH } from "@/auth";
import { deleteProject, saveViewSettings, setProjectHidden, setProjectPeopleField } from "@/app/actions/admin";
import { ProjectDashboard, type AdminDashboardProps, type LatestReport } from "@/components/ProjectDashboard";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import { DashboardViewModel, type DashboardRow } from "@/lib/dashboard/DashboardViewModel";
import { Db } from "@/lib/db/Db";
import { Assignee } from "@/lib/domain/Assignee";
import { Requester } from "@/lib/domain/Requester";
import { CompletedFiscalYear } from "@/lib/report/CompletedFiscalYear";
import type { FiscalYearCount } from "@/lib/domain/types";
import { DateOnly } from "@/lib/domain/DateOnly";
import { ViewSettings, type ViewColumn, type ViewSettingsByContext } from "@/lib/domain/ViewSettings";
import { ViewSettingsService } from "@/lib/services/ViewSettingsService";
import { VisibilityPolicy } from "@/lib/visibility/VisibilityPolicy";

interface DashboardLoad {
  rows: DashboardRow[];
  columns: ViewColumn[];
  latestReport: LatestReport | null;
  /** "Completed FY27 to date N" for the summary strip. Null when the data could not be loaded. */
  completedFiscalYear: FiscalYearCount | null;
  /** Present only for admins. */
  admin: Omit<AdminDashboardProps, "saveViewSettingsAction" | "setProjectHiddenAction" | "deleteProjectAction" | "setPeopleFieldAction"> | null;
  error: string | null;
}

class DashboardData {
  static defaultSettings(): ViewSettingsByContext {
    return { dashboard: ViewSettings.defaults("dashboard"), report: ViewSettings.defaults("report") };
  }

  static empty(viewer: Viewer, error: string): DashboardLoad {
    const settings = DashboardData.defaultSettings();
    return {
      rows: [],
      columns: ViewSettings.visibleColumns(settings.dashboard),
      latestReport: null,
      completedFiscalYear: null,
      admin: viewer.isAdmin
        ? { viewSettings: settings, pickerCounts: DashboardViewModel.adminPickerCounts([]), hiddenFromReportIds: [], ownerSuggestions: Assignee.ownerSuggestions([]), requesterSuggestions: [] }
        : null,
      error,
    };
  }

  /** Everything is filtered through VisibilityPolicy on the server; non-admins never receive hidden data. */
  static async load(viewer: Viewer, today: string): Promise<DashboardLoad> {
    if (!Db.isConfigured()) return DashboardData.empty(viewer, "DATABASE_URL is not configured.");
    try {
      const db = Db.client;
      const [projects, latest, settings] = await Promise.all([
        db.project.findMany({ where: { archivedAt: null } }),
        db.reportSnapshot.findFirst({
          orderBy: { generatedAt: "desc" },
          select: { generatedAt: true, periodStart: true, periodEnd: true },
        }),
        ViewSettingsService.getAll(db),
      ]);
      const visible = VisibilityPolicy.visibleProjects(projects, "dashboard", settings.dashboard);
      const history = await db.projectHistory.findMany({
        where: {
          projectId: { in: visible.map((p) => p.id) },
          ...(latest ? { changedAt: { gt: latest.generatedAt } } : {}),
          ...VisibilityPolicy.publicHistoryWhere(),
        },
        select: { projectId: true, changedAt: true, field: true },
        distinct: ["projectId"],
      });
      // "Updated <date>" on the meta line: latest public history entry per visible project (all time).
      const lastUpdates = await db.projectHistory.groupBy({
        by: ["projectId"],
        where: { projectId: { in: visible.map((p) => p.id) }, ...VisibilityPolicy.publicHistoryWhere() },
        _max: { changedAt: true },
      });
      const latestUpdates = lastUpdates.flatMap((g) =>
        g._max.changedAt ? [{ projectId: g.projectId, changedAt: g._max.changedAt, field: "update" }] : [],
      );
      // "Completed FY27 to date": same rule as the report (report candidates only, completedOn else the
      // day the status became Complete). Only Complete projects need their status history.
      const complete = projects.filter((p) => p.status === "Complete");
      const completionHistory = await db.projectHistory.findMany({
        where: { projectId: { in: complete.map((p) => p.id) }, field: { in: ["status", "created"] } },
        select: { projectId: true, changedAt: true, field: true, newValue: true },
      });
      const completedFiscalYear = CompletedFiscalYear.count({ projects: complete, history: completionHistory, reportDate: today });
      return {
        completedFiscalYear,
        rows: DashboardViewModel.rows(
          projects,
          settings.dashboard,
          history,
          latest?.generatedAt ?? null,
          today,
          latestUpdates,
        ),
        columns: ViewSettings.visibleColumns(settings.dashboard),
        latestReport: latest
          ? {
              reportDate: DateOnly.inZone(latest.generatedAt),
              periodStart: DateOnly.fromDbDate(latest.periodStart)!,
              periodEnd: DateOnly.fromDbDate(latest.periodEnd)!,
            }
          : null,
        admin: viewer.isAdmin
          ? {
              viewSettings: settings,
              pickerCounts: DashboardViewModel.adminPickerCounts(projects),
              hiddenFromReportIds: visible.filter((p) => p.hiddenFromReport).map((p) => p.id),
              ownerSuggestions: Assignee.ownerSuggestions(projects.map((p) => p.owner)),
              requesterSuggestions: Requester.suggestions(projects.map((p) => p.physicianChampion)),
            }
          : null,
        error: null,
      };
    } catch (e) {
      console.error("Failed to load projects", e);
      return DashboardData.empty(viewer, "Could not load projects from the database.");
    }
  }
}

export default async function DashboardPage() {
  // Defense in depth: the proxy already gates this route. Admin is re-evaluated on every request.
  const viewer = await CurrentViewer.get();
  if (!viewer) redirect(SIGN_IN_PATH);

  const today = DateOnly.today();
  const { rows, columns, latestReport, completedFiscalYear, admin, error } = await DashboardData.load(viewer, today);

  return (
    <ProjectDashboard
      rows={rows}
      columns={columns}
      today={today}
      userEmail={viewer.email}
      userName={viewer.name}
      latestReport={latestReport}
      completedFiscalYear={completedFiscalYear}
      loadError={error}
      // Spread so non-admins' payload does not even carry an "admin" key.
      {...(admin
        ? {
            admin: {
              ...admin,
              saveViewSettingsAction: async (context, value) => {
                "use server";
                const r = await saveViewSettings(context, value);
                return r.ok ? null : r.error;
              },
              setProjectHiddenAction: async (projectId, context, hidden) => {
                "use server";
                const r = await setProjectHidden(projectId, context, hidden);
                return r.ok ? null : r.error;
              },
              setPeopleFieldAction: async (projectId, field, value) => {
                "use server";
                const r = await setProjectPeopleField(projectId, field, value);
                return r.ok ? null : r.error;
              },
              deleteProjectAction: async (projectId) => {
                "use server";
                const r = await deleteProject(projectId);
                return r.ok ? null : r.error;
              },
            },
          }
        : {})}
      signOutAction={async () => {
        "use server";
        await signOut({ redirectTo: SIGN_IN_PATH });
      }}
    />
  );
}
