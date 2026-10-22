import { PeopleDirectory } from "@/lib/people/PeopleDirectory";
import { NameUsage } from "@/lib/people/NameUsage";
import { OwnerNameLists } from "@/lib/people/OwnerNameLists";
import { OwnerNamesService } from "@/lib/services/OwnerNamesService";
import { redirect } from "next/navigation";
import { signOut, SIGN_IN_PATH } from "@/auth";
import { createProjectFromForm, deleteProject, resetRowOrder, saveColumnLayout, saveProjectForm, saveProjectMilestones, saveRowOrder, saveViewSettings, setProjectHidden, setProjectPeopleField } from "@/app/actions/admin";
import { loadProjectHistory } from "@/app/actions/history";
import {
  addProjectBlocker,
  addProjectDependency,
  loadProjectDependencies,
  clearCompletedDependency,
  dismissCompletionPrompt,
  removeProjectDependency,
  resolveProjectBlocker,
  updateProjectBlocker,
  updateProjectDependency,
} from "@/app/actions/dependencies";
import type { BlockerInput, DependencyInput } from "@/lib/services/ProjectDependencyService";
import { BlockerSummaryService } from "@/lib/services/BlockerSummaryService";
import type { RowBlockers } from "@/lib/projects/BlockerSignals";
import { recordSuggestionOutcome, suggestNote } from "@/app/actions/ai";
import { applyAiChange, proposeAiChange, rejectAiChange, undoAiChange } from "@/app/actions/aiReview";
import { AiFeatureFlags, type AiReviewFeature } from "@/lib/ai/AiFeatureFlags";
import type { AiInput } from "@/lib/ai/AiInput";
import type { AiFeature } from "@/lib/ai/AiPrompts";
import { AiWritingModel } from "@/lib/ai/AiWritingModel";
import { AiToolsCopy } from "@/lib/ai/AiToolsCopy";
import { AiVoiceChatDrawer } from "@/components/AiVoiceChatDrawer";
import { AiModelService, type AiModelDb } from "@/lib/services/AiModelService";
import { AiPlacementData, AiToolsReadiness } from "@/lib/services/AiToolsReadiness";
import { AiSettingsService, type AiSettingsDb } from "@/lib/services/AiSettingsService";
import type { AiOutcome } from "@/lib/services/AiWritingService";
import { DashboardSettingsService } from "@/lib/services/DashboardSettingsService";
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
import { ProjectEditPolicy } from "@/lib/access/ProjectEditPolicy";
import { markProjectsReviewed, undoProjectsReviewed } from "@/app/actions/review";

/** AI Draft/Fit/Test connection server actions run on this page; the provider call can take up to AiProviderClient.TIMEOUT_MS (60 s). */
export const maxDuration = 90;

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
        ? { viewSettings: settings, pickerCounts: DashboardViewModel.adminPickerCounts([]), hiddenFromReportIds: [], ownerSuggestions: PeopleDirectory.merge(scope.owners), requesterSuggestions: PeopleDirectory.merge(scope.requesters), milestoneOwnerOptions: OwnerNameLists.combined(scope, []), menuItems: AdminMenu.itemsFor(viewer) ?? [], formValues: {}, milestoneSteps: {}, templates: [] }
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

  static stepsByProject<S extends { projectId: string }>(steps: readonly S[]): Map<string, S[]> {
    const out = new Map<string, S[]>();
    for (const s of steps) out.set(s.projectId, [...(out.get(s.projectId) ?? []), s]);
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
        // Latest row per project, so "Mark as reviewed" (ReportBuilder.isReviewed) sees the newest update.
        orderBy: [{ projectId: "asc" }, { changedAt: "desc" }],
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
      // 1b: blocker pills, Blocked filter and tile (dashboard only). A failure here never blocks the dashboard.
      const blockers = await BlockerSummaryService.forDashboard(db, scope.id, viewer.email, projects).catch((e) => {
        console.error("Failed to load blocker summary", e);
        return {} as Record<string, RowBlockers>;
      });
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
          DashboardData.stepsByProject(steps),
        ).map((r) => ({
          ...r,
          editable: ProjectEditPolicy.canEdit(viewer, scope, stored.find((p) => p.id === r.id) ?? null),
          ...(blockers[r.id] ? { blockers: blockers[r.id] } : {}),
        })),
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
              // Item 5: the pickers list the most used names first (ties A to Z), counted over the line's projects.
              nameUsage: NameUsage.counts(stored),
              // Milestone owners: every list of the line plus the milestone-owner list (a typed new name joins that one).
              milestoneOwnerOptions: await OwnerNamesService.pickerOptions(scope, db),
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
  // Draft and Fit paused: AI on, but its model is turned off under Models (the server refuses with MODEL_NOT_ALLOWED).
  const aiPaused = aiOn ? AiWritingModel.paused({ aiOn, modelOn: await AiSettingsService.modelOn(Db.client as unknown as AiSettingsDb, await AiModelService.enabledIds(Db.client, "chat")) }) : false;
  // PR B: Draft and Fit each have a row (toggle, env kill switch, provider and model). Off hides that button; no saved key
  // for its provider (or its own model off) shows it unavailable with a note. Following AI settings keeps today's rules.
  const writing = aiOn ? await AiToolsReadiness.writing(Db.client as unknown as AiModelDb & AiSettingsDb, aiPaused).catch(() => ({ shown: [...AiFeatureFlags.WRITING_FEATURES], paused: aiPaused, unavailable: {} })) : null;
  // Revise with AI: the admin toggle (ai_feature_settings, on by default) and the env kill switch.
  const reviseOn = aiOn ? await AiModelService.featureOn(Db.client, "revise_note") : false;
  // Voice chat in the header: hidden when the feature is off (no gap); greyed with the note when its model is off.
  const voiceNote = aiOn ? await AiToolsReadiness.voiceChatNote(Db.client as unknown as AiModelDb & AiSettingsDb).catch(() => AiToolsCopy.MODEL_OFF_NOTE) : AiToolsCopy.FEATURE_OFF_NOTE;
  const aiVoice = voiceNote === AiToolsCopy.FEATURE_OFF_NOTE || voiceNote === AiToolsCopy.AI_OFF_NOTE ? null : <AiVoiceChatDrawer disabledNote={voiceNote} />;
  // In-context AI buttons (placement spec): absent = feature off (not rendered); a note = model off (greyed).
  const aiPlacements = aiOn ? await AiPlacementData.load(Db.client as unknown as AiModelDb & AiSettingsDb).catch(() => undefined) : undefined;

  return (
    <ProjectDashboard
      rows={rows}
      columns={columns}
      today={today}
      userEmail={viewer.email}
      userName={viewer.name}
      heartbeat={await DashboardSettingsService.heartbeat()}
      // Mark as reviewed: for viewers who may edit the line's projects (each row's editable flag; re-checked on the server).
      {...(ProjectEditPolicy.canEditLine(viewer) ? { review: { markAction: markProjectsReviewed, undoAction: undoProjectsReviewed } } : {})}
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
              setPeopleFieldAction: async (projectId, field, value, opts) => {
                "use server";
                const r = await setProjectPeopleField(projectId, field, value, opts?.once === true);
                return r.ok ? null : r.error;
              },
              saveProjectFormAction: async (projectId, changes, milestones) => {
                "use server";
                return saveProjectForm(projectId, changes, milestones);
              },
              // Revise with AI (review-then-apply layer): AI on and the revise_note kill switch on (on by default).
              ...(reviseOn
                ? {
                    aiReview: {
                      proposeAction: async (projectId: string | null, feature: AiReviewFeature, current: string, input: AiInput) => {
                        "use server";
                        return proposeAiChange(projectId, feature, current, input);
                      },
                      applyAction: async (proposalId: string, text: string) => {
                        "use server";
                        return applyAiChange(proposalId, text);
                      },
                      rejectAction: async (proposalId: string) => {
                        "use server";
                        return rejectAiChange(proposalId);
                      },
                      undoAction: async (proposalId: string) => {
                        "use server";
                        return undoAiChange(proposalId);
                      },
                    },
                  }
                : {}),
              // Writing assistant: only when an admin turned AI on and it is fully configured (off by default).
              ...(aiOn && writing && writing.shown.length > 0
                ? {
                    aiWriting: {
                      paused: writing.paused,
                      features: writing.shown,
                      unavailable: writing.unavailable,
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
              createProjectAction: async (values, milestones) => {
                "use server";
                return createProjectFromForm(values, milestones);
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
              dependencyActions: {
                load: async (projectId: string) => {
                  "use server";
                  return loadProjectDependencies(projectId);
                },
                add: async (projectId: string, blockedById: string, input?: DependencyInput) => {
                  "use server";
                  return addProjectDependency(projectId, blockedById, input);
                },
                update: async (projectId: string, blockedById: string, input: DependencyInput) => {
                  "use server";
                  return updateProjectDependency(projectId, blockedById, input);
                },
                remove: async (projectId: string, blockedById: string, viewFor?: string) => {
                  "use server";
                  return removeProjectDependency(projectId, blockedById, viewFor);
                },
                addBlocker: async (projectId: string, input: BlockerInput) => {
                  "use server";
                  return addProjectBlocker(projectId, input);
                },
                updateBlocker: async (projectId: string, blockerId: string, input: BlockerInput) => {
                  "use server";
                  return updateProjectBlocker(projectId, blockerId, input);
                },
                resolveBlocker: async (projectId: string, blockerId: string, resolution: string) => {
                  "use server";
                  return resolveProjectBlocker(projectId, blockerId, resolution);
                },
                clearCompleted: async (projectId: string, blockedById: string) => {
                  "use server";
                  return clearCompletedDependency(projectId, blockedById);
                },
                dismissPrompt: async (projectId: string, blockedById: string) => {
                  "use server";
                  return dismissCompletionPrompt(projectId, blockedById);
                },
              },
            },
          }
        : {})}
      historyAction={loadProjectHistory}
      dependencyLoadAction={loadProjectDependencies}
      {...(aiVoice ? { aiVoice } : {})}
      {...(aiPlacements ? { aiPlacements } : {})}
      signOutAction={signOutAction}
    />
  );
}
