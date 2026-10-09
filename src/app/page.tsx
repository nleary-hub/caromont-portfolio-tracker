import { PeopleDirectory } from "@/lib/people/PeopleDirectory";
import { redirect } from "next/navigation";
import { signOut, SIGN_IN_PATH } from "@/auth";
import { createProjectFromForm, deleteProject, resetRowOrder, saveColumnLayout, saveProjectForm, saveProjectMilestones, saveRowOrder, saveViewSettings, setProjectHidden, setProjectPeopleField } from "@/app/actions/admin";
import { loadProjectHistory } from "@/app/actions/history";
import { recordSuggestionOutcome, suggestNote } from "@/app/actions/ai";
import type { AiFeature } from "@/lib/ai/AiPrompts";
import { AiSettingsService, type AiSettingsDb } from "@/lib/services/AiSettingsService";
import type { AiOutcome } from "@/lib/services/AiWritingService";
import { setDashboardHeartbeat } from "@/app/actions/preferences";
import { DashboardPrefsService } from "@/lib/services/DashboardPrefsService";
import { LineLayout, type LineLayoutValue } from "@/lib/layout/LineLayout";
import { LineLayoutService } from "@/lib/services/LineLayoutService";
import { ProjectDashboard, type AdminDashboardProps, type LatestReport } from "@/components/ProjectDashboard";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { AdminMenu } from "@/lib/admin/AdminMenu";
import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import { DashboardViewModel, type DashboardRow } from "@/lib/dashboard/DashboardViewModel";
import { FiscalYearRows } from "@/lib/dashboard/FiscalYearRows";
import { PeriodClosure } from "@/lib/report/PeriodClosure";
import { Db } from "@/lib/db/Db";
import { ProjectFormModel, type ProjectFormSource, type ProjectFormValues } from "@/lib/projects/ProjectFormModel";
import type { FiscalYearCount } from "@/lib/domain/types";
import { DateOnly } from "@/lib/domain/DateOnly";
import { ViewSettings, type ViewColumn, type ViewSettingsByContext } from "@/lib/domain/ViewSettings";
import { MilestoneProgress } from "@/lib/domain/MilestoneProgress";
import { MilestoneService } from "@/lib/services/MilestoneService";
import { MilestoneTemplateService } from "@/lib/services/MilestoneTemplateService";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { UpdateTimeline } from "@/lib/history/UpdateTimeline";
import { ServiceLine, type ServiceLineScope } from "@/lib/domain/ServiceLine";
import { ServiceLineSwitcher } from "@/components/ServiceLineSwitcher";
import { NoAccessCard } from "@/components/NoAccessCard";
import { LineGate } from "@/lib/access/LineGate";
import { ProjectLink } from "@/lib/access/ProjectLink";
import { ViewSettingsService } from "@/lib/services/ViewSettingsService";
import { VisibilityPolicy } from "@/lib/visibility/VisibilityPolicy";
import { ProjectRows } from "@/lib/domain/ProjectRows";

interface DashboardLoad {
  rows: DashboardRow[];
  columns: ViewColumn[];
  latestReport: LatestReport | null;
  /** "Completed FY27 to date N" for the summary strip. Null when the data could not be loaded. */
  completedFiscalYear: FiscalYearCount | null;
  /** The line's shared layout (everyone). */
  layout: LineLayoutValue;
  /** Present only for admins. */
  admin: Omit<
    AdminDashboardProps,
    "saveViewSettingsAction" | "setProjectHiddenAction" | "deleteProjectAction" | "setPeopleFieldAction" | "saveProjectFormAction" | "createProjectAction" | "saveMilestonesAction" | "saveColumnLayoutAction" | "saveRowOrderAction" | "resetRowOrderAction"
  > | null;
  error: string | null;
}

class DashboardData {
  static defaultSettings(): ViewSettingsByContext {
    return { dashboard: ViewSettings.defaults("dashboard"), report: ViewSettings.defaults("report") };
  }

  static empty(viewer: Viewer, error: string, scope: ServiceLineScope = ServiceLine.defaultScope()): DashboardLoad {
    const settings = DashboardData.defaultSettings();
    return {
      rows: [],
      columns: ViewSettings.visibleColumns(settings.dashboard),
      latestReport: null,
      completedFiscalYear: null,
      layout: LineLayout.defaults(),
      admin: viewer.isAdmin
        ? { viewSettings: settings, pickerCounts: DashboardViewModel.adminPickerCounts([]), hiddenFromReportIds: [], ownerSuggestions: PeopleDirectory.merge(scope.owners), requesterSuggestions: PeopleDirectory.merge(scope.requesters), menuItems: AdminMenu.itemsFor(viewer) ?? [], formValues: {}, milestoneSteps: {}, templates: [] }
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
  /** Scoped to the viewer's active service line: projects, people, templates and the latest report. */
  static async load(viewer: Viewer, today: string, scope: ServiceLineScope): Promise<DashboardLoad> {
    if (!Db.isConfigured()) return DashboardData.empty(viewer, "DATABASE_URL is not configured.", scope);
    try {
      const db = Db.client;
      const [stored, latest, settings, layout] = await Promise.all([
        db.project.findMany({ where: { archivedAt: null, ...ServiceLineAccess.projectWhere(scope) } }).then((rows) => ProjectRows.fromDbAll(rows)),
        db.reportSnapshot.findFirst({
          where: ServiceLineAccess.where(scope),
          orderBy: { generatedAt: "desc" },
          select: { generatedAt: true, periodStart: true, periodEnd: true },
        }),
        ViewSettingsService.getAll(db),
        LineLayoutService.getOrDefault(db, scope),
      ]);
      // Derived next milestone and due date (first step not done); projects without steps keep their legacy fields.
      const steps = await MilestoneService.loadSteps(db, stored.map((p) => p.id));
      const projects = MilestoneProgress.applyAll(stored, steps);
      // Only closed projects need their status history (closed date, and whether they were completed during the period).
      const closed = VisibilityPolicy.candidates(projects, "dashboard").filter((p) => p.status === "Complete" || p.status === "Cancelled");
      const closedHistory = await db.projectHistory.findMany({
        where: { projectId: { in: closed.map((p) => p.id) }, field: { in: ["status", "created"] } },
        select: { projectId: true, changedAt: true, field: true, oldValue: true, newValue: true },
      });
      // Completed since the line's latest freeze (every Complete project before the first freeze): they keep their
      // row in their department group until the next freeze, then live on the Completed page. Cancelled never shows.
      const completedInPeriod = PeriodClosure.ids(closed, closedHistory, latest?.generatedAt ?? null, new Date());
      const visible = VisibilityPolicy.visibleProjects(projects, "dashboard", settings.dashboard, completedInPeriod);
      const listedIds = [...new Set([...visible.map((p) => p.id), ...closed.map((p) => p.id)])];
      const history = await db.projectHistory.findMany({
        where: {
          projectId: { in: listedIds },
          ...(latest ? { changedAt: { gt: latest.generatedAt } } : {}),
          ...VisibilityPolicy.publicUpdateWhere(),
        },
        select: { projectId: true, changedAt: true, field: true },
        distinct: ["projectId"],
      });
      // "Updated <date>" on the meta line: latest public history entry per listed project (all time).
      const lastUpdates = await db.projectHistory.groupBy({
        by: ["projectId"],
        where: { projectId: { in: listedIds }, ...VisibilityPolicy.publicUpdateWhere() },
        _max: { changedAt: true },
      });
      const latestUpdates = lastUpdates.flatMap((g) =>
        g._max.changedAt ? [{ projectId: g.projectId, changedAt: g._max.changedAt, field: "update" }] : [],
      );
      const fiscalYearRows = FiscalYearRows.build({
        projects: closed,
        closedHistory,
        history,
        latestUpdates,
        previousSnapshotGeneratedAt: latest?.generatedAt ?? null,
        today,
      });
      const completedFiscalYear = FiscalYearRows.tile(fiscalYearRows, today);
      return {
        completedFiscalYear,
        layout,
        rows: DashboardViewModel.rows(
          projects,
          settings.dashboard,
          DashboardViewModel.flagHistory(history, closedHistory),
          latest?.generatedAt ?? null,
          today,
          latestUpdates,
          scope.departments,
          completedInPeriod,
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
              // The line's lists (Admin > People); blocked names are dropped even if stored.
              ownerSuggestions: PeopleDirectory.merge(scope.owners),
              requesterSuggestions: PeopleDirectory.merge(scope.requesters),
              menuItems: AdminMenu.itemsFor(viewer) ?? [],
              // The form reads the stored legacy fields; the checklist comes separately.
              formValues: DashboardData.formValues(stored, listedIds),
              milestoneSteps: MilestoneService.byProject(
                steps.filter((s) => listedIds.includes(s.projectId)),
                ServiceLine.peopleNames(scope),
              ),
              // "Checked by <you> at 1:45 AM ET. Not saved yet." (same name rule as History and saved checks).
              checkerName: UpdateTimeline.actor(viewer.email, ServiceLine.peopleNames(scope)),
              templates: await MilestoneTemplateService.listOrEmpty(db, scope),
            }
          : null,
        error: null,
      };
    } catch (e) {
      console.error("Failed to load projects", e);
      return DashboardData.empty(viewer, "Could not load projects from the database.", scope);
    }
  }
}

const signOutAction = async () => {
  "use server";
  await signOut({ redirectTo: SIGN_IN_PATH });
};

export default async function DashboardPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // Defense in depth: the proxy already gates this route. Admin and line access are re-evaluated on every request.
  const viewer = await CurrentViewer.get();
  if (!viewer) redirect(SIGN_IN_PATH);

  // Per-line access (item 8): no line = the no-access card only; ?line=EP opens one of your lines or names the one you lack.
  const params = await searchParams;
  const gate = await LineGate.forPage(viewer, params.line, "/");
  if (gate.kind === "switched") redirect(gate.to);
  if (gate.kind === "none") return <NoAccessCard email={viewer.email} signOutAction={signOutAction} />;
  if (gate.kind === "lacks") return <NoAccessCard email={viewer.email} signOutAction={signOutAction} line={gate.requested} goTo={{ shortName: gate.first.shortName, href: LineGate.href("/", gate.first.shortName) }} />;

  const { scope, lines } = gate;
  // Project links (/?project=<id>): the viewer's own projects open; anything else gets the project card (no name).
  const link = Db.isConfigured() ? await ProjectLink.resolve(viewer, params[ProjectLink.PARAM], scope, Db.client) : ({ kind: "none" } as const);
  if (link.kind === "switched") redirect(link.to);
  if (link.kind === "lacks") return <NoAccessCard email={viewer.email} signOutAction={signOutAction} project />;

  const today = DateOnly.today();
  const { rows, columns, latestReport, completedFiscalYear, layout, admin, error } = await DashboardData.load(viewer, today, scope);
  // Off by default: no settings row, the switch off, an incomplete setup or no tables yet all mean no AI buttons.
  const aiOn = Boolean(admin) && Db.isConfigured() ? await AiSettingsService.isOn(Db.client as unknown as AiSettingsDb) : false;

  return (
    <ProjectDashboard
      rows={rows}
      columns={columns}
      today={today}
      userEmail={viewer.email}
      userName={viewer.name}
      heartbeat={await DashboardPrefsService.heartbeat(viewer.email)}
      setHeartbeatAction={setDashboardHeartbeat}
      latestReport={latestReport}
      completedFiscalYear={completedFiscalYear}
      loadError={error}
      layout={layout}
      serviceLine={ServiceLine.valueOf(scope)}
      // Switching lines remounts the dashboard: an open drawer closes and filters reset to the line's own.
      key={scope.id}
      line={scope}
      {...(link.kind === "open" ? { initialProjectId: link.id } : {})}
      // Admins: always the switcher (with Manage service lines). Others: the switcher for 2+ lines, a plain label for one.
      switcher={viewer.isAdmin || lines.length > 1 ? <ServiceLineSwitcher lines={(lines.length ? lines : [scope]).map(ServiceLine.switcherEntry)} active={ServiceLine.switcherEntry(scope)} manage={viewer.isAdmin} /> : null}
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
              saveProjectFormAction: async (projectId, changes, milestones, meta) => {
                "use server";
                return saveProjectForm(projectId, changes, milestones, meta);
              },
              // Writing assistant: only when an admin turned AI on and it is fully configured (off by default).
              ...(aiOn
                ? {
                    aiWriting: {
                      suggestAction: async (projectId: string | null, feature: AiFeature, text: string) => {
                        "use server";
                        return suggestNote(projectId, feature, text);
                      },
                      outcomeAction: async (suggestionId: string, outcome: AiOutcome, unverifiedCount?: number) => {
                        "use server";
                        return recordSuggestionOutcome(suggestionId, outcome, unverifiedCount);
                      },
                    },
                  }
                : {}),
              saveMilestonesAction: async (projectId, milestones) => {
                "use server";
                return saveProjectMilestones(projectId, milestones);
              },
              createProjectAction: async (values, milestones, meta) => {
                "use server";
                return createProjectFromForm(values, milestones, meta);
              },
              saveColumnLayoutAction: async (value) => {
                "use server";
                const r = await saveColumnLayout(value);
                return r.ok ? null : r.error;
              },
              saveRowOrderAction: async (area, ids) => {
                "use server";
                const r = await saveRowOrder(area, ids);
                return r.ok ? null : r.error;
              },
              resetRowOrderAction: async () => {
                "use server";
                const r = await resetRowOrder();
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
      historyAction={loadProjectHistory}
      signOutAction={signOutAction}
    />
  );
}
