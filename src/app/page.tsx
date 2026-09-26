import { redirect } from "next/navigation";
import { signOut, SIGN_IN_PATH } from "@/auth";
import { createProjectFromForm, deleteProject, saveProjectForm, saveProjectMilestones, saveViewSettings, setProjectHidden, setProjectPeopleField } from "@/app/actions/admin";
import { ProjectDashboard, type AdminDashboardProps, type LatestReport } from "@/components/ProjectDashboard";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { AdminMenu } from "@/lib/admin/AdminMenu";
import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import { DashboardViewModel, type DashboardCompletedRow, type DashboardRow } from "@/lib/dashboard/DashboardViewModel";
import { Db } from "@/lib/db/Db";
import { Assignee } from "@/lib/domain/Assignee";
import { Requester } from "@/lib/domain/Requester";
import { ProjectFormModel, type ProjectFormSource, type ProjectFormValues } from "@/lib/projects/ProjectFormModel";
import { CompletedFiscalYear } from "@/lib/report/CompletedFiscalYear";
import type { FiscalYearCount } from "@/lib/domain/types";
import { DateOnly } from "@/lib/domain/DateOnly";
import { ViewSettings, type ViewColumn, type ViewSettingsByContext } from "@/lib/domain/ViewSettings";
import { MilestoneProgress } from "@/lib/domain/MilestoneProgress";
import { MilestoneService } from "@/lib/services/MilestoneService";
import { MilestoneTemplateService } from "@/lib/services/MilestoneTemplateService";
import { ServiceLineService } from "@/lib/services/ServiceLineService";
import { ViewSettingsService } from "@/lib/services/ViewSettingsService";
import { VisibilityPolicy } from "@/lib/visibility/VisibilityPolicy";

interface DashboardLoad {
  rows: DashboardRow[];
  /** "Completed this period" rows (the block at the end of each department group, as in the PDF). */
  completed: DashboardCompletedRow[];
  columns: ViewColumn[];
  latestReport: LatestReport | null;
  /** "Completed FY27 to date N" for the summary strip. Null when the data could not be loaded. */
  completedFiscalYear: FiscalYearCount | null;
  /** Present only for admins. */
  admin: Omit<
    AdminDashboardProps,
    "saveViewSettingsAction" | "setProjectHiddenAction" | "deleteProjectAction" | "setPeopleFieldAction" | "saveProjectFormAction" | "createProjectAction" | "saveMilestonesAction"
  > | null;
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
      completed: [],
      columns: ViewSettings.visibleColumns(settings.dashboard),
      latestReport: null,
      completedFiscalYear: null,
      admin: viewer.isAdmin
        ? { viewSettings: settings, pickerCounts: DashboardViewModel.adminPickerCounts([]), hiddenFromReportIds: [], ownerSuggestions: Assignee.ownerSuggestions([]), requesterSuggestions: [], menuItems: AdminMenu.itemsFor(viewer) ?? [], formValues: {}, milestoneSteps: {}, templates: [] }
        : null,
      error,
    };
  }

  /** Admin only: the drawer edit form's stored values for every listed project. */
  static formValues(projects: readonly (ProjectFormSource & { id: string })[], ids: readonly string[]): Record<string, ProjectFormValues> {
    const wanted = new Set(ids);
    const out: Record<string, ProjectFormValues> = {};
    for (const p of projects) {
      if (wanted.has(p.id)) out[p.id] = ProjectFormModel.fromSource(p);
    }
    return out;
  }

  /** Everything is filtered through VisibilityPolicy on the server; non-admins never receive hidden data. */
  static async load(viewer: Viewer, today: string): Promise<DashboardLoad> {
    if (!Db.isConfigured()) return DashboardData.empty(viewer, "DATABASE_URL is not configured.");
    try {
      const db = Db.client;
      const [stored, latest, settings] = await Promise.all([
        db.project.findMany({ where: { archivedAt: null } }),
        db.reportSnapshot.findFirst({
          orderBy: { generatedAt: "desc" },
          select: { generatedAt: true, periodStart: true, periodEnd: true },
        }),
        ViewSettingsService.getAll(db),
      ]);
      // Derived next milestone and due date (first step not done); projects without steps keep their legacy fields.
      const steps = await MilestoneService.loadSteps(db, stored.map((p) => p.id));
      const projects = MilestoneProgress.applyAll(stored, steps);
      const visible = VisibilityPolicy.visibleProjects(projects, "dashboard", settings.dashboard);
      // "Completed FY27 to date": same rule as the report (report candidates only, completedOn else the
      // day the status became Complete). Only Complete projects need their status history. The same
      // history picks the "Completed this period" rows (CompletedThisPeriod, as the PDF does).
      const complete = projects.filter((p) => p.status === "Complete");
      const completionHistory = await db.projectHistory.findMany({
        where: { projectId: { in: complete.map((p) => p.id) }, field: { in: ["status", "created"] } },
        select: { projectId: true, changedAt: true, field: true, newValue: true },
      });
      const completedThisPeriod = DashboardViewModel.completedThisPeriod({
        projects,
        history: completionHistory,
        reportSettings: settings.report,
        rowIds: visible.map((p) => p.id),
        now: new Date(),
      });
      const listedIds = [...visible.map((p) => p.id), ...completedThisPeriod.map((c) => c.projectId)];
      const history = await db.projectHistory.findMany({
        where: {
          projectId: { in: listedIds },
          ...(latest ? { changedAt: { gt: latest.generatedAt } } : {}),
          ...VisibilityPolicy.publicHistoryWhere(),
        },
        select: { projectId: true, changedAt: true, field: true },
        distinct: ["projectId"],
      });
      // "Updated <date>" on the meta line: latest public history entry per listed project (all time).
      const lastUpdates = await db.projectHistory.groupBy({
        by: ["projectId"],
        where: { projectId: { in: listedIds }, ...VisibilityPolicy.publicHistoryWhere() },
        _max: { changedAt: true },
      });
      const latestUpdates = lastUpdates.flatMap((g) =>
        g._max.changedAt ? [{ projectId: g.projectId, changedAt: g._max.changedAt, field: "update" }] : [],
      );
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
        completed: DashboardViewModel.completedRows(projects, completedThisPeriod, history, latest?.generatedAt ?? null, today, latestUpdates),
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
              menuItems: AdminMenu.itemsFor(viewer) ?? [],
              // The form reads the stored legacy fields; the checklist comes separately.
              formValues: DashboardData.formValues(stored, listedIds),
              milestoneSteps: MilestoneService.byProject(steps.filter((s) => listedIds.includes(s.projectId))),
              templates: await MilestoneTemplateService.listOrEmpty(db),
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
  const [{ rows, completed, columns, latestReport, completedFiscalYear, admin, error }, serviceLine] = await Promise.all([
    DashboardData.load(viewer, today),
    ServiceLineService.getOrDefault(),
  ]);

  return (
    <ProjectDashboard
      rows={rows}
      completed={completed}
      columns={columns}
      today={today}
      userEmail={viewer.email}
      userName={viewer.name}
      latestReport={latestReport}
      completedFiscalYear={completedFiscalYear}
      loadError={error}
      serviceLine={serviceLine}
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
              saveProjectFormAction: async (projectId, changes, milestones) => {
                "use server";
                return saveProjectForm(projectId, changes, milestones);
              },
              saveMilestonesAction: async (projectId, milestones) => {
                "use server";
                return saveProjectMilestones(projectId, milestones);
              },
              createProjectAction: async (values, milestones) => {
                "use server";
                return createProjectFromForm(values, milestones);
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
