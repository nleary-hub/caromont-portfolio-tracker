"use client";

import { CompletionCopy } from "@/lib/projects/CompletionCopy";
import { CompletionTag } from "./CompletionTag";
import dynamic from "next/dynamic";
import Link from "next/link";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ViewContext } from "@/generated/prisma/enums";
import { DashboardViewModel, DateFormat, type DashboardRow } from "@/lib/dashboard/DashboardViewModel";
import { Assignee } from "@/lib/domain/Assignee";
import { Requester } from "@/lib/domain/Requester";
import { MilestoneStepsSection, PreviouslyLine, ProjectHistorySection, UpdateNotesSection, useProjectTimeline, type HistoryLoader } from "./ProjectHistory";
import type { FiscalYearCount } from "@/lib/domain/types";
import { FiscalYear } from "@/lib/domain/FiscalYear";
import { InforNumber } from "@/lib/domain/InforNumber";
import { ProjectStatusInfo } from "@/lib/domain/ProjectStatusInfo";
import { ServiceAreaInfo, type DepartmentKey, type DepartmentList } from "@/lib/domain/ServiceAreaInfo";
import type { StatusCounts } from "@/lib/domain/types";
import { ViewSettings, type ViewColumn, type ViewSettingsByContext, type ViewSettingsValue } from "@/lib/domain/ViewSettings";
import type { AdminMenuItem } from "@/lib/admin/AdminMenu";
import type { ServiceLineScope, ServiceLineValue } from "@/lib/domain/ServiceLine";
import { ProjectFormModel, type ProjectFormValues } from "@/lib/projects/ProjectFormModel";
import type { MilestoneEdit } from "@/lib/domain/MilestoneRules";
import { MilestoneProgress } from "@/lib/domain/MilestoneProgress";
import type { MilestoneStepDto } from "@/lib/services/MilestoneService";
import type { TemplateDto } from "@/lib/services/MilestoneTemplateService";
import type { ProjectEditFormHandle, ProjectFormSubmit } from "./ProjectEditForm";
import { DependenciesSection, type DependencyActions } from "./DependenciesSection";
import { BlockedFilterChip, BlockedTile } from "./BlockedControls";
import { BlockerSignals } from "@/lib/projects/BlockerSignals";
import type { DependencyActionResult } from "@/app/actions/dependencies";
import { DependencyCopy } from "@/lib/projects/DependencyCopy";
import type { AiFeature } from "@/lib/ai/AiPrompts";
import type { AiOutcome, AiSuggestResult } from "@/lib/services/AiWritingService";
import type { AiReviewFeature } from "@/lib/ai/AiFeatureFlags";
import type { AiInput } from "@/lib/ai/AiInput";
import type { AiDecisionResult, AiProposeResult } from "@/lib/services/AiReviewApplyService";
import type { AiReviewActions } from "./AiReviewPanel";
import type { MilestoneSaveActionResult } from "@/app/actions/admin";
import { DashboardTopBar, type TopBarReport } from "./DashboardTopBar";
import type { PeopleFieldName } from "./ProjectPeopleEditor";
import { DashboardTable, DueFlagPill, type DashboardLayoutControl } from "./DashboardTable";
import { ActionToast, RowFade, type ActionToastValue } from "./ActionToast";
import { ClosedPagesCopy } from "@/lib/closed/ClosedPagesCopy";
import { ClosedPageModel } from "@/lib/closed/ClosedPageModel";
import { PrintOrder } from "@/lib/dashboard/PrintOrder";
import type { InlineEditControl } from "./InlineRowEdit";
import { DashboardQuery, type DashboardQueryState, type DashboardSortKey } from "@/lib/dashboard/DashboardQuery";
import { DueFilterSelect, MarkAllReviewedButton, MultiFilterSelect, QueryCopy, ReviewConfirmDialog, SortChip, statusOptions } from "./DashboardQueryControls";
import type { ReviewActionResult } from "@/app/actions/review";
import { LayoutCopy, LineLayout, type ColumnLayoutValue, type LineLayoutValue } from "@/lib/layout/LineLayout";
import type { AreaGroup } from "@/lib/domain/ServiceAreaInfo";
import { DepartmentsSelect, TileVisibilityButton } from "./DashboardFilterControls";
import { DashboardPrefs, type DashboardTile } from "@/lib/dashboard/DashboardPrefs";
import { DepartmentFilter } from "@/lib/domain/DepartmentFilter";
import { Flags, StatusPill } from "./StatusPill";
import { StartDateDefaultTag } from "./StartDateDefaultTag";
import { StartDate } from "@/lib/projects/StartDate";
import { DashboardAmbient, DrawerSpotlight, SummaryHeartbeat } from "./DashboardAmbient";
import { AccountMenu } from "./AccountMenu";
import { MfiCheckbox, MfiChip } from "./MfiChip";
import type { AiPlacementNotes, AiRowShortcut } from "./AiPlacements";
import { AiToolsCopy } from "@/lib/ai/AiToolsCopy";
import { AiWritingModel } from "@/lib/ai/AiWritingModel";

// Admin-only UI is code-split: the chunks load only when an admin renders them.
// AI placements use server actions: loaded on demand so importing the dashboard never pulls them in (tests, non-AI views).
const AiBriefButton = dynamic(() => import("./AiPlacements").then((m) => m.AiBriefButton));
const AiQuickCapture = dynamic(() => import("./AiPlacements").then((m) => m.AiQuickCapture));
const AiRowMenu = dynamic(() => import("./AiPlacements").then((m) => m.AiRowMenu));
const AiToolbarMenu = dynamic(() => import("./AiPlacements").then((m) => m.AiToolbarMenu));
const AiNextStepPanel = dynamic(() => import("./AiNextStepPanel").then((m) => m.AiNextStepPanel));
const AiDependencySuggestPanel = dynamic(() => import("./AiDependencySuggestPanel").then((m) => m.AiDependencySuggestPanel));
const ViewSettingsPicker = dynamic(() => import("./ViewSettingsPicker").then((m) => m.ViewSettingsPicker));
const ProjectAdminControls = dynamic(() => import("./ProjectAdminControls").then((m) => m.ProjectAdminControls));
const ProjectPeopleEditor = dynamic(() => import("./ProjectPeopleEditor").then((m) => m.ProjectPeopleEditor));
const AdminMenuButton = dynamic(() => import("./AdminMenuButton").then((m) => m.AdminMenuButton));
const ProjectEditForm = dynamic(() => import("./ProjectEditForm").then((m) => m.ProjectEditForm));

/** The latest frozen report (top bar chip). */
export type LatestReport = TopBarReport;

/** Only passed for admins. Non-admins receive none of this (no settings, counts or actions). */
export interface AdminDashboardProps {
  viewSettings: ViewSettingsByContext;
  /** Per-status counts for the picker (before status settings apply). */
  pickerCounts: Record<ViewContext, StatusCounts>;
  /** Visible dashboard rows that are hidden from the report. */
  hiddenFromReportIds: string[];
  /** Each action resolves to an error message, or null on success. */
  saveViewSettingsAction: (context: ViewContext, value: ViewSettingsValue) => Promise<string | null>;
  setProjectHiddenAction: (projectId: string, context: ViewContext, hidden: boolean) => Promise<string | null>;
  deleteProjectAction: (projectId: string) => Promise<string | null>;
  /** Owner datalist for the drawer edit panel (department leaders plus existing owners). */
  ownerSuggestions: string[];
  /** Existing requester names for the drawer requester picker (admin only). */
  requesterSuggestions: string[];
  /** Milestone Owner picker names: Owners, Requesters, Contracts leads and the milestone-owner list (migration 0036). */
  milestoneOwnerOptions: string[];
  setPeopleFieldAction: (projectId: string, field: PeopleFieldName, value: string) => Promise<string | null>;
  /** Top bar admin menu items (`AdminMenu.itemsFor`, computed on the server). */
  menuItems: AdminMenuItem[];
  /** Drawer edit form values per listed project (stored values, as form strings). */
  formValues: Record<string, ProjectFormValues>;
  /** The signed-in admin's display name, for "Checked by <name> at 1:45 AM ET. Not saved yet." */
  checkerName?: string;
  /** Stored checklist steps per listed project (drawer Milestones section). */
  milestoneSteps: Record<string, MilestoneStepDto[]>;
  /** Milestone templates for "Apply a template". */
  templates: TemplateDto[];
  /** Drawer Milestones autosave ("Saves as you go"): one checklist change, saved immediately. */
  saveMilestonesAction: (projectId: string, milestones: MilestoneEdit) => Promise<MilestoneSaveActionResult>;
  /** Edit form Save: the changed non-People fields, saved together (one history entry). Milestones autosave. */
  saveProjectFormAction: (projectId: string, changes: Partial<ProjectFormValues>, milestones: MilestoneEdit | null) => ReturnType<ProjectFormSubmit>;
  /**
   * Writing assistant (Draft from bullets, Fit for report) in the update-note editor. Present only when an admin turned
   * AI on and it is fully configured; absent, the editor is exactly as before.
   */
  aiWriting?: {
    /** projectId null: the New project form. */
    suggestAction: (projectId: string | null, feature: AiFeature, text: string) => Promise<AiSuggestResult>;
    outcomeAction: (suggestionId: string, outcome: AiOutcome, unverifiedCount?: number) => Promise<boolean>;
    /** On, but the model is turned off under Models: Draft and Fit show as paused with the model-off note. */
    paused?: boolean;
    /** PR B: the buttons that are on (absent = both). A feature turned off in AI settings is not rendered. */
    features?: readonly AiFeature[];
    /** PR B: a button that can't run for its own reason (no saved key for its provider, its own model off), with its note. */
    unavailable?: Partial<Record<AiFeature, string>>;
  };
  /** Revise with AI (review-then-apply layer). Present only when AI is on and the revise_note kill switch is on. */
  aiReview?: {
    proposeAction: (projectId: string | null, feature: AiReviewFeature, current: string, input: AiInput) => Promise<AiProposeResult>;
    applyAction: (proposalId: string, text: string) => Promise<AiDecisionResult>;
    rejectAction: (proposalId: string) => Promise<AiDecisionResult>;
    undoAction: (proposalId: string) => Promise<AiDecisionResult>;
  };
  /** New project drawer: create (name and department required), with its checklist. */
  createProjectAction: (values: Partial<ProjectFormValues>, milestones: MilestoneEdit | null) => ReturnType<ProjectFormSubmit>;
  /** Line layout: save column order and width shares (null = reset columns). */
  saveColumnLayoutAction: (columns: ColumnLayoutValue | null) => Promise<string | null>;
  /** Line layout: one department's manual order (empty = report order there). */
  saveRowOrderAction: (area: string, ids: string[]) => Promise<string | null>;
  /** Line layout: reset the manual order in every department. */
  resetRowOrderAction: () => Promise<string | null>;
  /** Drawer Dependencies section (migration 0037). Absent, the section is not shown. */
  dependencyActions?: DependencyActions;
}

/** Admin drawer mode: detail view, edit form, or the empty New project form. */
export type DrawerMode = "view" | "edit" | "new";

/** How long a newly created project's row stays highlighted after it scrolls into view. */
export class NewRowFlash {
  static readonly MS = 1500;
}

/** Binds the review-then-apply actions to one project (null: the New project form). */
function reviewActions(r: NonNullable<AdminDashboardProps["aiReview"]>, projectId: string | null): AiReviewActions {
  return {
    propose: (current, input) => r.proposeAction(projectId, "revise_note", current, input),
    apply: (id, text) => r.applyAction(id, text),
    reject: (id) => r.rejectAction(id),
    undo: (id) => r.undoAction(id),
  };
}

interface Props {
  /** Already filtered by VisibilityPolicy on the server. */
  rows: DashboardRow[];
  /** Visible dashboard columns in order. */
  columns: ViewColumn[];
  today: string;
  userEmail: string;
  userName: string | null;
  latestReport: LatestReport | null;
  /** "Completed FY27 to date N": the Completed page's count for the current year (dashboard visibility). Links there. */
  completedFiscalYear?: FiscalYearCount | null;
  loadError: string | null;
  /** Service line name setting (top bar lockup). */
  serviceLine: ServiceLineValue;
  /** The active service line (departments, contracts leads, per-line prefs). Absent = the default line. */
  line?: ServiceLineScope;
  /** Admins: the service line switcher, shown in place of the plain name. */
  switcher?: ReactNode;
  admin?: AdminDashboardProps;
  /** The line's shared layout (column widths and order, row order). Everyone gets it; only admins change it. */
  layout?: LineLayoutValue;
  signOutAction: () => Promise<void>;
  /** Project detail > History for the signed-in viewer (everyone; the server applies the visibility rules). */
  historyAction?: HistoryLoader;
  /** Read-only "Dependencies & blockers" load for non-admins (admins use admin.dependencyActions). */
  dependencyLoadAction?: (projectId: string) => Promise<DependencyActionResult>;
  /** Dashboard header Voice chat (AiVoiceChatDrawer, built by the page): present only when AI and voice_chat are on. */
  aiVoice?: ReactNode;
  /** AI tools where people work (placement spec). Absent key = that feature is off (not rendered). */
  aiPlacements?: AiPlacementNotes;
  /** A project link (/?project=<id>) the server checked: its detail opens on load. */
  initialProjectId?: string;
  /** Account menu > Dashboard heartbeat, as saved on the account (default On). */
  heartbeat?: boolean;
  /** Saves the switch; resolves to the saved value, or null when the save failed (the switch goes back). */
  setHeartbeatAction?: (on: boolean) => Promise<boolean | null>;
  /**
   * "Mark as reviewed" and its Undo. Present when the viewer may edit projects of the line (ProjectEditPolicy); each
   * row's own `editable` decides whether it gets the button, and the server re-checks every project.
   */
  review?: {
    markAction: (ids: string[], bulk: boolean) => Promise<ReviewActionResult>;
    undoAction: (ids: string[], at: string) => Promise<ReviewActionResult>;
  };
}

/** Browser localStorage, or null (server render, private mode, or storage blocked). */
class DashboardPrefsBrowser {
  static storage(): Storage | null {
    try {
      return typeof window === "undefined" ? null : window.localStorage;
    } catch {
      return null;
    }
  }
}

class Initials {
  static of(name: string | null, email: string): string {
    const source = name?.trim() || email.split("@")[0].replace(/[._-]+/g, " ");
    const parts = source.split(/\s+/).filter(Boolean);
    return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
  }
}

export function ProjectDashboard({
  rows,
  today,
  userEmail,
  userName,
  latestReport,
  completedFiscalYear,
  loadError,
  serviceLine,
  line,
  switcher,
  columns: columnsProp,
  admin,
  layout: layoutProp,
  signOutAction,
  historyAction,
  dependencyLoadAction,
  aiVoice,
  aiPlacements,
  initialProjectId,
  heartbeat: heartbeatProp = true,
  setHeartbeatAction,
  review,
}: Props) {
  // Filters, search and sort (per user and line in localStorage, like Departments). The search box updates at once;
  // the rows follow after DashboardQuery.SEARCH_DEBOUNCE_MS.
  const [q, setQState] = useState<DashboardQueryState>(() => DashboardQuery.empty());
  const [query, setQueryInput] = useState("");
  // The dashboard follows the switch at once. A failed save keeps the choice on screen (until a reload) and shows an
  // inline error in the account menu instead of silently putting the switch back. Only the latest click reports.
  const [heartbeat, setHeartbeat] = useState(heartbeatProp);
  const [heartbeatSaveFailed, setHeartbeatSaveFailed] = useState(false);
  const heartbeatSeq = useRef(0);
  const changeHeartbeat = (on: boolean) => {
    setHeartbeat(on);
    setHeartbeatSaveFailed(false);
    const seq = ++heartbeatSeq.current;
    const failed = () => seq === heartbeatSeq.current && setHeartbeatSaveFailed(true);
    void setHeartbeatAction?.(on)
      .then((saved) => saved === null && failed())
      .catch(failed);
  };
  const [selectedId, setSelectedId] = useState<string | null>(initialProjectId ?? null);
  // AI toolbar menu: rows picked with Ctrl or Cmd click for "Bulk edit selected (N)".
  // Row "..." AI shortcuts: open the edit drawer, then focus that field's AI button once the form is there.
  const rowShortcuts: AiRowShortcut[] = [
    ...(admin && aiPlacements && "next_step" in aiPlacements ? [{ key: "next_step" as const, label: AiToolsCopy.NEXT_INLINE, note: aiPlacements.next_step ?? null }] : []),
    ...(admin?.aiWriting && AiWritingModel.shown(admin.aiWriting).includes("draft_from_bullets")
      ? [{ key: "draft" as const, label: AiToolsCopy.ROW_DRAFT, note: admin.aiWriting.paused ? AiToolsCopy.MODEL_OFF_NOTE : (admin.aiWriting.unavailable?.draft_from_bullets ?? null) }]
      : []),
  ];
  const openShortcut = (id: string, key: AiRowShortcut["key"]) =>
    guard(() => {
      leaveForm();
      setSelectedId(id);
      setMode("edit");
      const testId = key === "next_step" ? "ai-tool-next_step-propose" : "ai-draft";
      let tries = 0;
      const focus = () => {
        const el = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
        if (el) {
          el.scrollIntoView({ block: "center" });
          el.focus();
        } else if (++tries < 20) setTimeout(focus, 50);
      };
      setTimeout(focus, 50);
    });
  const [multiIds, setMultiIds] = useState<ReadonlySet<string>>(() => new Set());
  const toggleMulti = (id: string) => setMultiIds((cur) => { const next = new Set(cur); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  // What "/" calls: set by the top bar (focus the search field, or open it when it is collapsed to an icon).
  const focusSearchRef = useRef<() => void>(() => {});
  // Admin edit mode. The project drawer opens straight into the edit form for admins (no Edit click);
  // non-admins stay in "view" (there is no way to switch).
  const openMode = (id: string | null): DrawerMode => (id && admin?.formValues[id] ? "edit" : "view");
  const [mode, setMode] = useState<DrawerMode>(() => openMode(initialProjectId ?? null));
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const dirtyRef = useRef(false);
  const formRef = useRef<ProjectEditFormHandle>(null);
  const pendingRef = useRef<(() => void) | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const scrollToRef = useRef<string | null>(null);
  // Admin only: optimistic copy of the settings (rows refresh from the server after each save).
  const [settings, setSettings] = useState<ViewSettingsByContext | null>(admin?.viewSettings ?? null);

  // Line layout (server side, shared by everyone on the line). Admin changes apply optimistically and roll back on failure.
  const [lineLayout, setLineLayout] = useState<LineLayoutValue>(layoutProp ?? LineLayout.defaults());
  const [layoutError, setLayoutError] = useState<string | null>(null);
  const sort = q.sort;
  const persistLayout = async (next: LineLayoutValue, save: () => Promise<string | null>): Promise<string | null> => {
    const previous = lineLayout;
    setLineLayout(next);
    setLayoutError(null);
    let err: string | null;
    try {
      err = await save();
    } catch {
      err = LayoutCopy.SAVE_FAILED;
    }
    if (err) {
      setLineLayout(previous);
      setLayoutError(LayoutCopy.SAVE_FAILED);
    }
    return err ? LayoutCopy.SAVE_FAILED : null;
  };
  const saveColumns = (columns: ColumnLayoutValue | null) =>
    admin ? persistLayout({ ...lineLayout, columns: LineLayout.isDefaultColumns(columns) ? null : columns }, () => admin.saveColumnLayoutAction(columns)) : Promise.resolve("Not authorized.");
  const saveRowOrder = (area: AreaGroup, ids: string[]) => {
    if (!admin) return Promise.resolve("Not authorized.");
    const rowsNext = { ...lineLayout.rows };
    if (ids.length) rowsNext[area] = ids;
    else delete rowsNext[area];
    return persistLayout({ ...lineLayout, rows: rowsNext }, () => admin.saveRowOrderAction(area, ids));
  };
  const resetRows = () => (admin ? persistLayout({ ...lineLayout, rows: {} }, () => admin.resetRowOrderAction()) : Promise.resolve("Not authorized."));
  const notInReport = useMemo(() => {
    const hidden = new Set(admin?.hiddenFromReportIds ?? []);
    return new Set(rows.filter((r) => PrintOrder.notInReport(r, hidden, settings?.report)).map((r) => r.id));
  }, [rows, admin?.hiddenFromReportIds, settings?.report]);
  const layoutControl: DashboardLayoutControl = {
    value: lineLayout,
    canEdit: Boolean(admin),
    sort,
    onColumns: (next) => void saveColumns(next),
    onRowOrder: (area, ids) => void saveRowOrder(area, ids),
  };

  // Per-user preferences in localStorage (department filter, hidden tiles). Defaults until read after mount,
  // so the server render and the first client render agree.
  // The line's filter options (the #20 four for the default line) and its own saved prefs.
  const deptOptions = useMemo(() => DashboardPrefs.options(line), [line]);
  const [departments, setDepartmentsState] = useState<DepartmentKey[]>(() => DepartmentFilter.all(deptOptions));
  const [hiddenTiles, setHiddenTilesState] = useState<DashboardTile[]>([]);
  // "As it will print" (per user and line, localStorage): on by default, the dashboard in the PDF's order.
  const [printOrder, setPrintOrderState] = useState<boolean>(PrintOrder.DEFAULT_ON);
  const setPrintOrder = (on: boolean) => {
    setPrintOrderState(on);
    PrintOrder.write(DashboardPrefsBrowser.storage(), userEmail, on, line);
  };
  useEffect(() => {
    const storage = DashboardPrefsBrowser.storage();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time read of browser-only storage after hydration
    setDepartmentsState(DashboardPrefs.readDepartments(storage, userEmail, line));
    setHiddenTilesState(DashboardPrefs.readHiddenTiles(storage, userEmail, line));
    setPrintOrderState(PrintOrder.read(storage, userEmail, line));
    const saved = DashboardQuery.read(storage, userEmail, line);
    setQState(saved);
    setQueryInput(saved.search);
  }, [userEmail, line]);
  const setQ = (next: DashboardQueryState) => {
    setQState(next);
    DashboardQuery.write(DashboardPrefsBrowser.storage(), userEmail, next, line);
  };
  const qRef = useRef(q);
  useEffect(() => {
    qRef.current = q;
  });
  const setQuery = (text: string) => setQueryInput(text);
  useEffect(() => {
    if (query === qRef.current.search) return;
    const t = setTimeout(() => {
      const next = { ...qRef.current, search: query };
      setQState(next);
      DashboardQuery.write(DashboardPrefsBrowser.storage(), userEmail, next, line);
    }, query ? DashboardQuery.SEARCH_DEBOUNCE_MS : 0);
    return () => clearTimeout(t);
  }, [query, userEmail, line]);
  const onSort = (key: DashboardSortKey) => setQ({ ...q, sort: DashboardQuery.nextSort(q.sort, key) });
  const clearAll = () => {
    setQueryInput("");
    setQ(DashboardQuery.clearAll(q));
  };
  const setDepartments = (next: DepartmentKey[]) => {
    setDepartmentsState(next);
    DashboardPrefs.writeDepartments(DashboardPrefsBrowser.storage(), userEmail, next, line);
  };
  const setHiddenTiles = (next: DashboardTile[]) => {
    setHiddenTilesState(next);
    DashboardPrefs.writeHiddenTiles(DashboardPrefsBrowser.storage(), userEmail, next, line);
  };

  // Department filter first (the Departments dropdown is the only department filter): tiles, rows and the
  // Unassigned group all follow it. Options are the line's departments (every department for CVPSL).
  const deptRows = useMemo(() => DepartmentFilter.apply(rows, departments, deptOptions), [rows, departments, deptOptions]);
  const summary = useMemo(() => DashboardViewModel.summarize(deptRows), [deptRows]);
  const visible = useMemo(() => DashboardQuery.apply(deptRows, q, today, line?.departments), [deptRows, q, today, line]);
  const filtered = DashboardQuery.isFiltered(q);
  // "IR · 3 of 5" while filtering: each department's rows before the filters (after Departments).
  const groupTotals = useMemo(() => {
    if (!filtered) return undefined;
    const out: Partial<Record<string, number>> = {};
    for (const r of deptRows) {
      const g = ServiceAreaInfo.groupOf(r.serviceArea);
      out[g] = (out[g] ?? 0) + 1;
    }
    return out;
  }, [deptRows, filtered]);
  // Mark as reviewed: rows marked here drop Changed at once (the server data follows on refresh).
  const [reviewedIds, setReviewedIds] = useState<ReadonlySet<string>>(new Set());
  const [confirmBulk, setConfirmBulk] = useState(false);
  const shownRows = useMemo(() => (reviewedIds.size ? visible.map((r) => (reviewedIds.has(r.id) && r.changed ? { ...r, changed: false } : r)) : visible), [visible, reviewedIds]);
  const reviewable = review ? shownRows.filter((r) => r.changed && r.editable) : [];
  const markReviewed = async (ids: string[], bulk: boolean, name: string | null): Promise<string | null> => {
    if (!review || ids.length === 0) return null;
    let r: ReviewActionResult;
    try {
      r = await review.markAction(ids, bulk);
    } catch {
      r = { ok: false, error: "Could not save the change." };
    }
    if (!r.ok) {
      setToast({ text: r.error, error: true });
      return r.error;
    }
    setReviewedIds((cur) => new Set([...cur, ...ids]));
    const at = r.at;
    setToast({
      text: bulk || !name ? QueryCopy.markedMany(r.count) : QueryCopy.markedOne(name),
      ms: QueryCopy.UNDO_MS,
      action: {
        label: QueryCopy.UNDO,
        run: () => {
          void review.undoAction(ids, at).then((u) => {
            if (u.ok) {
              setReviewedIds((cur) => new Set([...cur].filter((id) => !ids.includes(id))));
              setToast({ text: QueryCopy.UNDONE });
            } else setToast({ text: u.error, error: true });
          });
        },
      },
    });
    return null;
  };
  // 1b: blocker summary (dashboard only; report counts never include it). Present once the server sent it.
  const hasBlockers = deptRows.some((r) => r.blockers !== undefined);
  const blockedRows = deptRows.filter((r) => BlockerSignals.isBlocked(r.blockers)).length;
  const overdueFollowUps = deptRows.reduce((n, r) => n + BlockerSignals.overdueFollowUps(r.blockers, today), 0);
  const [focusDeps, setFocusDeps] = useState<string | null>(null);
  const tiles = DashboardPrefs.visibleTiles(hiddenTiles, Boolean(completedFiscalYear), hasBlockers);
  const tileTemplate = DashboardPrefs.gridTemplate(tiles);
  const emptyLine = DashboardViewModel.isEmptyLine(line, rows.length, Boolean(loadError));
  // Non-admins get only the visible columns in order; that is the same model with nothing hidden.
  // Non-admins: flags is in columnsProp only when the status chips are on (the server applied the setting).
  const dashboardView: ViewSettingsValue = settings?.dashboard ?? { columnOrder: columnsProp, hiddenColumns: [], hiddenStatuses: [] };
  const showInfor = ViewSettings.visibleColumns(dashboardView).includes("inforNumber");
  const selected = rows.find((r) => r.id === selectedId) ?? null;
  // The side panel slides in when it opens, not when it switches between detail and edit.
  // Edit drawer header "Blocked by n" (from the Dependencies section once it loads).
  const [blockedCount, setBlockedCount] = useState<{ id: string; n: number } | null>(null);
  const drawerOpen = (mode === "new" && Boolean(admin)) || Boolean(selected);
  const [drawerWasOpen, setDrawerWasOpen] = useState(drawerOpen);
  const [drawerEntering, setDrawerEntering] = useState(false);
  if (drawerWasOpen !== drawerOpen) {
    setDrawerWasOpen(drawerOpen);
    setDrawerEntering(drawerOpen);
  }
  // Completed and Cancelled pages keep this view: current FY, and the dashboard's department filter.
  const closedView = { fy: FiscalYear.of(today).label, departments };
  const closedQuery = ClosedPageModel.query(closedView, today, deptOptions, line?.departments ?? ServiceAreaInfo.LEGACY);
  const [toast, setToast] = useState<ActionToastValue | null>(null);
  // Set when an edit form save changes the status to Cancelled: the project leaves the dashboard at once.
  const cancelledRef = useRef<{ id: string; name: string } | null>(null);
  const submitForm = (id: string, name: string, changes: Partial<ProjectFormValues>, milestones: MilestoneEdit | null) =>
    admin!.saveProjectFormAction(id, changes, milestones).then(
      (r) => {
        const cancelling = changes.status === "Cancelled";
        if (cancelling && r.ok) cancelledRef.current = { id, name: String(changes.name ?? name) };
        if (cancelling && !r.ok) setToast({ text: ClosedPagesCopy.CANCEL_ERROR, error: true });
        return r;
      },
      (e) => {
        if (changes.status === "Cancelled") setToast({ text: ClosedPagesCopy.CANCEL_ERROR, error: true });
        throw e;
      },
    );

  // Inline row update (admins): the same submitForm as the drawer, so saveProjectForm writes history and audit rows.
  const inlineEdit = useMemo<InlineEditControl | undefined>(
    () => (admin ? { values: admin.formValues, today, save: (id, changes) => submitForm(id, rows.find((r) => r.id === id)?.name ?? "", changes, null) } : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- submitForm reads admin; rows only name a cancelled project
    [admin, today, rows],
  );

  /** Optimistic: apply locally, persist, roll back on failure. */
  const saveSettings = async (context: ViewContext, value: ViewSettingsValue): Promise<string | null> => {
    if (!admin || !settings) return "Not authorized.";
    if (context === "dashboard" && lineLayout.columns) {
      // This line has its own column order: a reorder in the View menu changes the line layout (not the order
      // shared by every line); show/hide still saves to the dashboard view settings.
      const order = LineLayout.orderFromSettings("dashboard", value, lineLayout.columns.order);
      if (order.join() !== lineLayout.columns.order.join()) {
        const err = await saveColumns({ ...lineLayout.columns, order });
        if (err) return err;
      }
      value = { ...value, columnOrder: settings.dashboard.columnOrder };
      if (ViewSettings.equals(value, settings.dashboard)) return null;
    }
    const previous = settings[context];
    setSettings((s) => (s ? { ...s, [context]: value } : s));
    try {
      const err = await admin.saveViewSettingsAction(context, value);
      if (err) setSettings((s) => (s ? { ...s, [context]: previous } : s));
      return err;
    } catch {
      setSettings((s) => (s ? { ...s, [context]: previous } : s));
      return "Couldn't save the dashboard view. Try again.";
    }
  };

  const onDirtyChange = useCallback((dirty: boolean) => {
    dirtyRef.current = dirty;
  }, []);

  /**
   * Run `action` (close, another row, New project). Editing a project: first flush the pending auto-save; when it
   * fails the drawer stays open on the error. New project: ask "Discard changes?" when the form has entries.
   */
  const guard = (action: () => void) => {
    const editForm = mode === "edit" ? formRef.current : null;
    if (editForm) {
      void editForm.flush().then((ok) => {
        if (ok) action();
      });
      return;
    }
    if (mode === "new" && dirtyRef.current) {
      pendingRef.current = action;
      setConfirmDiscard(true);
      return;
    }
    action();
  };
  const leaveForm = () => {
    dirtyRef.current = false;
    setConfirmDiscard(false);
    pendingRef.current = null;
  };
  const closeDrawer = () => {
    leaveForm();
    setMode("view");
    setSelectedId(null);
  };
  const requestClose = () => guard(closeDrawer);
  const selectRow = (id: string | null) =>
    guard(() => {
      leaveForm();
      setMode(openMode(id));
      setSelectedId(id);
    });
  const openNew = () =>
    guard(() => {
      leaveForm();
      setSelectedId(null);
      setMode("new");
    });
  const discard = () => {
    const pending = pendingRef.current;
    leaveForm();
    pending?.();
  };
  const onSaved = (id: string) => {
    const created = mode === "new";
    const cancelled = cancelledRef.current;
    cancelledRef.current = null;
    if (cancelled && cancelled.id === id) {
      // Set to Cancelled: close the drawer, fade the row out (it is gone once the rows refresh) and say where it went.
      closeDrawer();
      RowFade.out(id);
      setToast({
        text: ClosedPagesCopy.cancelledToast(cancelled.name),
        link: { href: ClosedPageModel.href(ClosedPageModel.CANCELLED.path, closedView, today, deptOptions, line?.departments ?? ServiceAreaInfo.LEGACY), label: ClosedPagesCopy.VIEW_ON_CANCELLED },
      });
      return;
    }
    leaveForm();
    setMode(openMode(id));
    if (created && id) {
      // Show the new project whatever the current filter, then scroll its row into view.
      clearAll();
      setDepartments(DepartmentFilter.all(deptOptions));
      setSelectedId(id);
      scrollToRef.current = id;
      setFlashId(id);
    }
  };

  // After a create, the row arrives with the refreshed rows: scroll to it and flash it.
  useEffect(() => {
    const id = scrollToRef.current;
    if (!id) return;
    const el = document.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(id)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    scrollToRef.current = null;
  }, [flashId, rows, visible]);
  useEffect(() => {
    if (!flashId) return;
    const t = setTimeout(() => setFlashId(null), NewRowFlash.MS);
    return () => clearTimeout(t);
  }, [flashId]);

  // The key handler is registered once; it calls the latest close logic through a ref.
  const escRef = useRef<() => void>(() => {});
  useEffect(() => {
    escRef.current = () => {
      if (confirmDiscard) setConfirmDiscard(false);
      else requestClose();
    };
  });

  // A click on the page outside the drawer closes it (after the pending save). Rows select on their own, controls
  // (buttons, fields, links, column headers) do their own job, and menus and pickers render outside <main>
  // (portals), so none of those count as outside.
  useEffect(() => {
    if (!drawerOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      if (!t || !t.closest("main") || t.closest(ProjectDashboardCopy.OUTSIDE_IGNORE)) return;
      escRef.current();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [drawerOpen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (e.key === "/" && !typing) {
        e.preventDefault();
        focusSearchRef.current();
      } else if (e.key === "Escape") {
        escRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const avatar = (
    <div className="grid size-[30px] place-items-center rounded-full border border-(--status-on-hold-dark-fg) bg-(--status-on-hold-dark-bg) type-label font-semibold text-(--status-on-hold-dark-fg)">
      {Initials.of(userName, userEmail)}
    </div>
  );
  return (
    <div className="pb-page relative min-h-screen">
      <DashboardAmbient />
      <DashboardTopBar
        serviceLine={serviceLine}
        switcher={switcher}
        latestReport={latestReport}
        query={query}
        onQuery={setQuery}
        focusSearchRef={focusSearchRef}
        viewPicker={
          admin && settings
            ? (compact) => (
                <ViewSettingsPicker
                  settings={lineLayout.columns ? { ...settings, dashboard: LineLayout.orderedSettings("dashboard", settings.dashboard, lineLayout.columns.order) } : settings}
                  counts={admin.pickerCounts}
                  onSave={saveSettings}
                  layoutReset={{ shortName: serviceLine.shortName, onResetColumns: () => saveColumns(null), onResetRows: resetRows }}
                  compact={compact}
                />
              )
            : undefined
        }
        viewKey={settings ? String(ViewSettings.hiddenCount(settings.dashboard)) : ""}
        closedQuery={closedQuery}
        pdfDepartments={departments}
        adminMenu={admin && admin.menuItems.length > 0 ? <AdminMenuButton items={admin.menuItems} /> : undefined}
        aiActions={
          aiVoice || (aiPlacements && "quick_capture" in aiPlacements) ? (
            <>
              {aiVoice}
              {aiPlacements && "quick_capture" in aiPlacements && <AiQuickCapture note={aiPlacements.quick_capture ?? null} {...("dictation" in aiPlacements ? { dictationNote: aiPlacements.dictation ?? null } : {})} />}
            </>
          ) : undefined
        }
        account={
            <form action={signOutAction} className="flex shrink-0 items-center gap-2 whitespace-nowrap text-muted">
              {/* Below 1100px the name drops and the avatar itself opens the account menu; Sign out stays beside it. */}
              <div className="max-[1100px]:hidden">{avatar}</div>
              <div className="flex flex-col type-caption max-[1100px]:flex-row max-[1100px]:items-center max-[1100px]:gap-2">
                <AccountMenu name={userName ?? userEmail} heartbeat={heartbeat} onHeartbeatChange={changeHeartbeat} saveFailed={heartbeatSaveFailed} avatar={avatar} />
                <button type="submit" className="text-left hover:text-fg">
                  Sign out
                </button>
              </div>
            </form>
        }
      />

      <main className="flex flex-col gap-4 px-6 pt-5 pb-6">
        {loadError && (
          <p role="alert" className="rounded-card border border-line bg-card px-3 py-2 text-danger">
            {loadError}
          </p>
        )}

        {emptyLine && <EmptyLineState line={line!} admin={Boolean(admin)} onNew={openNew} />}

        {/* A line with no projects shows only the banner; tiles, toolbar and table appear with the first project. */}
        {/* Top row: the status tiles at full width. The Pre-meeting brief, when that feature is on, gets its own row below. */}
        {!emptyLine && tileTemplate && (
          <section className="pb-summary relative grid gap-2" style={{ gridTemplateColumns: tileTemplate }} aria-label="Status summary">
            {tiles.map((t) =>
              t === "completedFy" ? (
                completedFiscalYear && <CompletedFiscalYearCard key={t} fy={completedFiscalYear} href={ClosedPageModel.tileHref()} beat={heartbeat} />
              ) : t === "blocked" ? (
                <BlockedTile key={t} count={blockedRows} overdue={overdueFollowUps} on={q.blocked} onClick={() => setQ({ ...q, blocked: !q.blocked })} beat={heartbeat} />
              ) : (
                <div key={t} data-tile={t} className="pb-tile flex min-w-0 flex-col items-start gap-1.5 rounded-card border border-line bg-card px-3 py-2.5">
                  {heartbeat && <span className="pb-tile-beat" aria-hidden="true" />}
                  <div className="type-metric">{summary.byStatus[t]}</div>
                  <StatusPill status={t} />
                </div>
              ),
            )}
            {/* Heartbeat switch Off: no line, head, trail or washes are rendered and no animation runs. */}
            {heartbeat && <SummaryHeartbeat tilesKey={tiles.join(",")} />}
          </section>
        )}

        {!emptyLine && (
        <section className="flex flex-col gap-1.5" aria-label="Filters">
        <div className="flex flex-wrap items-center gap-1.5" data-testid="filter-bar">
          <DepartmentsSelect value={departments} onChange={setDepartments} options={deptOptions} list={line?.departments} limited={Boolean(line?.departmentLimit)} />
          <DueFilterSelect value={q.due} onChange={(due) => setQ({ ...q, due })} />
          <MultiFilterSelect label="Status" testId="status-filter" options={statusOptions(deptRows)} value={q.statuses} onChange={(v) => setQ({ ...q, statuses: v as DashboardQueryState["statuses"] })} width={130} />
          <MultiFilterSelect label="Project owner" testId="project-owner-filter" searchable options={DashboardQuery.ownerOptions(deptRows, "project")} value={q.projectOwners} onChange={(v) => setQ({ ...q, projectOwners: v })} width={160} />
          <MultiFilterSelect label="Milestone owner" testId="task-owner-filter" searchable options={DashboardQuery.ownerOptions(deptRows, "task")} value={q.taskOwners} onChange={(v) => setQ({ ...q, taskOwners: v })} width={150} />
          {hasBlockers && <BlockedFilterChip count={blockedRows} on={q.blocked} onChange={(blocked) => setQ({ ...q, blocked })} />}
          <div className="flex-1" />
          {layoutError && (
            <span role="alert" className="mr-2 text-danger type-caption">
              {layoutError}
            </span>
          )}
          {!printOrder && <SortChip text={DashboardQuery.sortChip(sort)} onManual={() => setQ({ ...q, sort: null })} />}
          {aiPlacements && <AiToolbarMenu notes={aiPlacements} selected={rows.filter((r) => multiIds.has(r.id)).map((r) => ({ id: r.id, name: r.name }))} visible={visible.map((r) => ({ id: r.id, name: r.name }))} />}
          {review && <MarkAllReviewedButton count={reviewable.length} onClick={() => setConfirmBulk(true)} />}
          {admin && (
            <button
              type="button"
              onClick={openNew}
              className="ml-2 flex h-7 shrink-0 items-center rounded-control btn-primary bg-accent-strong px-3 whitespace-nowrap text-white type-table-strong"
            >
              + New project
            </button>
          )}
          <PrintOrderSwitch on={printOrder} onChange={setPrintOrder} />
          <TileVisibilityButton
            tiles={DashboardPrefs.availableTiles(Boolean(completedFiscalYear), hasBlockers)}
            hidden={hiddenTiles}
            labelOf={(t) => (t === "completedFy" || t === "blocked" ? DashboardPrefs.tileLabel(t, completedFiscalYear?.label ?? null) : <span className={`pill st-${t}`}>{ProjectStatusInfo.label(t)}</span>)}
            onChange={setHiddenTiles}
          />
        </div>
        <div className="flex items-center gap-2 type-caption text-muted" data-testid="count-line">
          <span role="status">{DashboardQuery.countLine(visible.length, deptRows.length, q.search)}</span>
          {filtered && (
            <button type="button" onClick={clearAll} className="text-accent hover:underline" data-testid="clear-all">
              {QueryCopy.CLEAR_ALL}
            </button>
          )}
        </div>
        </section>
        )}

        {!emptyLine && (
        <section className="pb-table overflow-hidden rounded-card border border-line bg-card">
          <div data-pb-scroll className="max-h-[calc(100vh-260px)] overflow-auto">
            <DashboardTable
              rows={shownRows}
              onSort={onSort}
              search={q.search}
              groupTotals={groupTotals}
              onReview={review ? (r) => void markReviewed([r.id], false, r.name) : undefined}
              empty={
                filtered && rows.length > 0 ? (
                  <span className="flex flex-col items-center gap-2" data-testid="filters-empty">
                    <span>{q.search.trim() && !DashboardQuery.isFiltered({ ...q, search: "" }) ? QueryCopy.noSearchMatch(q.search.trim()) : QueryCopy.NO_MATCH}</span>
                    <button type="button" onClick={clearAll} className="rounded-control border border-line px-3 py-1 text-fg type-table-strong hover:bg-row-selected">
                      {QueryCopy.CLEAR_ALL_FILTERS}
                    </button>
                  </span>
                ) : undefined
              }
              settings={dashboardView}
              selectedId={selectedId}
              {...(aiPlacements && ("bulk_edit" in aiPlacements || "meeting_notes" in aiPlacements) ? { multiIds, onMultiToggle: toggleMulti } : {})}
              {...(rowShortcuts.length && admin ? { rowMenu: (r: DashboardRow) => (admin.formValues[r.id] ? <AiRowMenu rowName={r.name} items={rowShortcuts} onPick={(k) => openShortcut(r.id, k)} /> : null) } : {})}
              flashId={flashId}
              onSelect={selectRow}
              onBlockers={(id) => {
                setFocusDeps(id);
                selectRow(id);
              }}
              today={today}
              emptyText={rows.length === 0 ? "No projects yet." : "No projects match the current filter."}
              renderMeta={(r) => <ProjectMetaLine row={r} showInfor={showInfor} />}
              layout={layoutControl}
              departments={line?.departments}
              printOrder={printOrder}
              notInReport={notInReport}
              inlineEdit={inlineEdit}
            />
          </div>
          <div className="flex justify-between border-t border-line px-3 py-2.5 text-muted type-caption">
            <span>
              {visible.length} of {rows.length} projects
            </span>
            <span>Changed means edited since the last report or the last review.</span>
          </div>
        </section>
        )}
      </main>

      {drawerOpen && <DrawerSpotlight rowId={mode === "new" ? null : selectedId} />}
      {mode === "new" && admin ? (
        <ProjectDrawer
          entering={drawerEntering}
          onEntered={() => setDrawerEntering(false)}
          row={null}
          departments={line?.departments}
          today={today}
          onClose={requestClose}
          peopleEditor={null}
          adminControls={null}
          form={() => (
            <ProjectEditForm
              key="new"
              mode="new"
              {...(line ? { departments: line.departments } : {})}
              original={ProjectFormModel.empty(today)}
              milestones={[]}
              templates={admin.templates}
              ownerOptions={admin.milestoneOwnerOptions}
              checkerName={admin.checkerName}
              today={today}
              people={null}
              adminDelete={null}
              onSubmit={admin.createProjectAction}
              {...(admin.aiReview ? { aiReview: reviewActions(admin.aiReview, null) } : {})}
              {...(admin.aiWriting
                ? {
                    ai: {
                      ...AiWritingModel.availability(admin.aiWriting),
                      suggest: (feature: AiFeature, text: string) => admin.aiWriting!.suggestAction(null, feature, text),
                      outcome: (suggestionId: string, outcome: AiOutcome, unverifiedCount?: number) =>
                        unverifiedCount === undefined ? admin.aiWriting!.outcomeAction(suggestionId, outcome) : admin.aiWriting!.outcomeAction(suggestionId, outcome, unverifiedCount),
                    },
                    aiPaused: Boolean(admin.aiWriting.paused),
                  }
                : {})}
              onSaved={onSaved}
              onCancel={requestClose}
              onDirtyChange={onDirtyChange}
              confirmDiscard={confirmDiscard}
              onKeepEditing={() => setConfirmDiscard(false)}
              onDiscard={discard}
            />
          )}
        />
      ) : (
        selected && (
          <ProjectDrawer
            entering={drawerEntering}
            onEntered={() => setDrawerEntering(false)}
            row={selected}
            historyAction={historyAction}
            departments={line?.departments}
            today={today}
            onClose={requestClose}
            headerTag={blockedCount?.id === selected.id && blockedCount.n > 0 ? <BlockedByTag n={blockedCount.n} /> : null}
            {...(!admin && dependencyLoadAction
              ? { dependencies: <DependenciesSection key={`deps-ro-${selected.id}`} projectId={selected.id} actions={{ load: dependencyLoadAction }} onOpenProject={setSelectedId} flags={BlockerSignals.flags(selected, selected.blockers, today)} focus={focusDeps === selected.id} /> }
              : {})}
            {...(aiPlacements && "meeting_brief" in aiPlacements ? { headerAction: <AiBriefButton note={aiPlacements.meeting_brief ?? null} projectId={selected.id} projectName={selected.name} /> } : {})}
            peopleEditor={
              admin ? (
                <ProjectPeopleEditor
                  key={`people-${selected.id}`}
                  projectId={selected.id}
                  owner={selected.owner}
                  physicianChampion={selected.physicianChampion}
                  requesterNotApplicable={selected.requesterNotApplicable}
                  requesterSuggestions={admin.requesterSuggestions}
                  contractsLead={selected.contractsLead}
                  serviceArea={selected.serviceArea}
                  {...(line ? { contractsLeads: line.contractsLeads, departments: line.departments } : {})}
                  ownerSuggestions={admin.ownerSuggestions}
                  saveAction={admin.setPeopleFieldAction}
                />
              ) : null
            }
            adminControls={
              admin ? (
                <ProjectAdminControls
                  heading={false}
                  projectId={selected.id}
                  projectName={selected.name}
                  hiddenFromReport={admin.hiddenFromReportIds.includes(selected.id)}
                  setHiddenAction={admin.setProjectHiddenAction}
                  deleteAction={admin.deleteProjectAction}
                  onGone={closeDrawer}
                />
              ) : null
            }
            form={
              admin && admin.formValues[selected.id]
                ? (parts) => (
                <ProjectEditForm
                  key={`edit-${selected.id}`}
                  handleRef={formRef}
                  inforPreviously={parts.previously}
                  trailing={parts.trailing}
                  adminExtra={parts.admin}
                  mode="edit"
                  {...(line ? { departments: line.departments } : {})}
                  original={admin.formValues[selected.id]}
                  startDateIsDefault={Boolean(selected.startDateIsDefault)}
                  milestones={admin.milestoneSteps[selected.id] ?? []}
                  checkerName={admin.checkerName}
                  templates={admin.templates}
                  ownerOptions={admin.milestoneOwnerOptions}
                  today={today}
                  {...(aiPlacements && "next_step" in aiPlacements ? { aiNextStep: <AiNextStepPanel key={`next-${selected.id}`} inline projects={[{ id: selected.id, name: selected.name }]} initialProject={selected.id} disabledNote={aiPlacements.next_step ?? null} /> } : {})}
                  dependencies={
                    admin.dependencyActions ? (
                      // AI "Find related" is gone from the drawer: it saved related projects as Blocked by (same fix
                      // as #86). Item 8: AI blocker suggestions live here, with a direction and a reason per line.
                      <DependenciesSection
                        key={`deps-${selected.id}`}
                        projectId={selected.id}
                        actions={admin.dependencyActions}
                        onOpenProject={setSelectedId}
                        flags={BlockerSignals.flags(selected, selected.blockers, today)}
                        focus={focusDeps === selected.id}
                        onCount={(n) => setBlockedCount((prev) => (prev?.id === selected.id && prev.n === n ? prev : { id: selected.id, n }))}
                        {...(aiPlacements && "related_links" in aiPlacements ? { ai: (reload: () => void) => <AiDependencySuggestPanel projectId={selected.id} disabledNote={aiPlacements.related_links ?? null} onApplied={reload} /> } : {})}
                      />
                    ) : null
                  }
                  people={
                    <ProjectPeopleEditor
                      key={`form-${selected.id}`}
                      inForm
                      projectId={selected.id}
                      owner={selected.owner}
                      physicianChampion={selected.physicianChampion}
                      requesterNotApplicable={selected.requesterNotApplicable}
                      requesterSuggestions={admin.requesterSuggestions}
                      contractsLead={selected.contractsLead}
                      serviceArea={selected.serviceArea}
                      {...(line ? { contractsLeads: line.contractsLeads } : {})}
                      ownerSuggestions={admin.ownerSuggestions}
                      saveAction={admin.setPeopleFieldAction}
                    />
                  }
                  adminDelete={
                    <ProjectAdminControls
                      part="delete"
                      projectId={selected.id}
                      projectName={selected.name}
                      hiddenFromReport={admin.hiddenFromReportIds.includes(selected.id)}
                      setHiddenAction={admin.setProjectHiddenAction}
                      deleteAction={admin.deleteProjectAction}
                      onGone={closeDrawer}
                    />
                  }
                  onSubmit={(changes, milestones) => submitForm(selected.id, selected.name, changes, milestones)}
                  {...(admin.aiReview ? { aiReview: reviewActions(admin.aiReview, selected.id) } : {})}
                  {...(admin.aiWriting
                    ? {
                        ai: {
                          ...AiWritingModel.availability(admin.aiWriting),
                          suggest: (feature: AiFeature, text: string) => admin.aiWriting!.suggestAction(selected.id, feature, text),
                          outcome: (suggestionId: string, outcome: AiOutcome, unverifiedCount?: number) =>
                            unverifiedCount === undefined ? admin.aiWriting!.outcomeAction(suggestionId, outcome) : admin.aiWriting!.outcomeAction(suggestionId, outcome, unverifiedCount),
                        },
                        aiPaused: Boolean(admin.aiWriting.paused),
                      }
                    : {})}
                  saveMilestones={(edit) => admin.saveMilestonesAction(selected.id, edit)}
                  onSaved={onSaved}
                  onCancel={requestClose}
                  onDirtyChange={onDirtyChange}
                  confirmDiscard={confirmDiscard}
                  onKeepEditing={() => setConfirmDiscard(false)}
                  onDiscard={discard}
                />
                  )
                : undefined
            }
          />
        )
      )}
      {confirmBulk && review && (
        <ReviewConfirmDialog
          count={reviewable.length}
          filtered={filtered || !DepartmentFilter.isAll(departments, deptOptions)}
          onCancel={() => setConfirmBulk(false)}
          onConfirm={async () => {
            const err = await markReviewed(reviewable.map((r) => r.id), true, null);
            if (!err) setConfirmBulk(false);
            return err;
          }}
        />
      )}
      {toast && <ActionToast key={toast.text} value={toast} ms={toast.ms} onDone={() => setToast(null)} />}
    </div>
  );
}

/**
 * Owner or requester name, or "To assign" when blank: regular weight, same size as a name, in the secondary
 * text color (--dark-text-secondary). Not a warning, so no amber, icon or chip.
 */
/** Summary strip card: teal check and count, "Completed FY27 to date" under it. With `href`, a link to the Completed page. */
export function CompletedFiscalYearCard({ fy, href, beat = true }: { fy: FiscalYearCount; href?: string; beat?: boolean }) {
  const body = (
    <>
      {beat && <span className="pb-tile-beat" aria-hidden="true" />}
      <div className="type-metric text-(--status-on-track-dark-fg)">{fy.count}</div>
      <span className="type-caption text-(--status-on-track-dark-fg)">&#10003; {FiscalYear.completedLabel(fy.label)}</span>
    </>
  );
  const box = "pb-tile pb-fy flex flex-col items-start gap-1.5 rounded-card border border-line bg-card px-3 py-2.5";
  return href ? (
    <Link href={href} data-testid="completed-fy" aria-label={ClosedPagesCopy.tileLink(fy.label)} className={`${box} hover:border-(--dark-text-secondary)`}>
      {body}
    </Link>
  ) : (
    <div data-testid="completed-fy" className={box}>
      {body}
    </div>
  );
}

/** Requester cell: the name, muted "To assign" when not yet addressed, nothing when Not applicable. */
export function RequesterText({ name, notApplicable }: { name: string | null; notApplicable: boolean }) {
  const d = Requester.display(name, notApplicable);
  if (!d) return null;
  return d.muted ? <span className="font-normal text-muted">{d.text}</span> : <>{d.text}</>;
}

export function AssigneeText({ value }: { value: string | null }) {
  return Assignee.isAssigned(value) ? <>{value}</> : <span className="font-normal text-muted">{Assignee.TO_ASSIGN}</span>;
}

/** Dashboard meta line geometry. The designer tunes these two values. */
export class DashboardMetaLine {
  /** Fixed slot for "REQ-99999": 9 characters of the 9px monospace font. */
  static readonly INFOR_SLOT_WIDTH = "9ch";
  /** Gap between the slot and "Updated". */
  static readonly INFOR_GAP = "8px";
}

/**
 * Small gray line under the project name: "REQ-5081  Updated Sep 24". The number sits left-aligned in a
 * fixed-width monospace slot (9px, slightly brighter) followed by a fixed gap, so "Updated" lines up on
 * numbered row. No number, or the column hidden in the view settings: no slot and no gap, so "Updated"
 * starts at the left edge under the name. Stale amber applies to the Updated date only.
 */
export function ProjectMetaLine({ row, showInfor }: { row: DashboardRow; showInfor: boolean }) {
  const updated = DateFormat.short(row.updatedOn);
  const req = InforNumber.format(row.inforRequestNumber);
  if (!updated && !(showInfor && req)) return null;
  return (
    <div className="truncate text-[10px] leading-3 font-normal text-muted">
      {showInfor && req && (
        <span
          data-testid="infor-slot"
          className="font-mono text-[9px] text-[#B8BEC8]"
          style={{ display: "inline-block", width: DashboardMetaLine.INFOR_SLOT_WIDTH, marginRight: DashboardMetaLine.INFOR_GAP, textAlign: "left" }}
        >
          {req}
        </span>
      )}
      {updated && (
        <span className={row.stale ? "font-medium text-(--status-at-risk-dark-fg)" : undefined}>Updated {updated}</span>
      )}
    </div>
  );
}

/** What the drawer hands the edit form: the "Previously" Infor line and the read-only sections after the fields. */
export interface DrawerFormParts {
  previously: ReactNode;
  trailing: ReactNode;
  /** Admin controls (Hide from dashboard, Hide from report), shown in the form's Admin section above Delete. */
  admin: ReactNode;
}

/**
 * The one project panel. Admins on the dashboard get the edit form in place (`form`); everyone else (and the
 * Closed pages) get the same panel with the fields read-only. History, Update notes and the admin controls
 * load in both.
 */
/** Drawer outside-click rules (also used by the Closed and Cancelled pages). */
export const ProjectDashboardCopy = {
  OUTSIDE_IGNORE: 'aside.pb-drawer, tr[data-row-key], thead, button, a, input, select, textarea, label, [role="button"], [role="menuitem"], [role="option"]',
} as const;

export function ProjectDrawer({
  row,
  today,
  onClose,
  peopleEditor,
  adminControls,
  form,
  departments,
  historyAction,
  headerAction,
  headerTag,
  dependencies,
  entering = false,
  onEntered,
}: {
  /** Read-only "Dependencies & blockers" (non-admins), under the details. The edit form carries its own. */
  dependencies?: ReactNode;
  /** True on the render that opens the panel: it slides in once. */
  entering?: boolean;
  onEntered?: () => void;
  /** A secondary action in the header, right of the title (Brief; Restore to active on the Cancelled page). */
  headerAction?: ReactNode;
  /** Small tag next to the edit header caption ("Blocked by 2"). */
  headerTag?: ReactNode;
  /** Null for the New project form. */
  row: DashboardRow | null;
  /** Loads the History section and the "Previously" Infor numbers. */
  historyAction?: HistoryLoader;
  /** The line's departments (the department's short name in the header and detail). */
  departments?: DepartmentList;
  today: string;
  onClose: () => void;
  /** Admin edit form (edit or New project), built with the drawer's History parts. Absent: read-only fields. */
  form?: (parts: DrawerFormParts) => ReactNode;
  /** Admin-only people editor at the top of the read-only fields. Null otherwise. */
  peopleEditor: ReactNode;
  /** Admin-only controls (Hide from dashboard, Hide from report). Null for non-admins. */
  adminControls: ReactNode;
}) {
  const history = useProjectTimeline(row?.id ?? "", row, row ? historyAction : undefined);
  const editing = Boolean(form);
  const trailing =
    row && historyAction ? (
      <>
        {!editing && <MilestoneStepsSection timeline={history.timeline} />}
        <UpdateNotesSection key={`notes-${row.id}`} timeline={history.timeline} />
        {/* People and History are siblings: their project-specific keys must have distinct namespaces. */}
        <ProjectHistorySection key={`history-${row.id}`} timeline={history.timeline} loading={history.loading} />
      </>
    ) : null;
  const closeButton = (
    <button type="button" onClick={onClose} aria-label="Close" className="pb-ghost size-7 rounded-[6px] border border-line text-xs text-muted hover:text-fg">
      ✕
    </button>
  );
  return (
    <aside
      aria-label={row ? "Project detail" : "New project"}
      data-mode={editing ? "edit" : "view"}
      data-enter={entering || undefined}
      onAnimationEnd={(e) => e.target === e.currentTarget && onEntered?.()}
      className="pb-drawer fixed top-[208px] right-6 bottom-6 z-20 flex w-[440px] flex-col overflow-clip rounded-card border border-line bg-card shadow-[-16px_0_40px_rgba(0,0,0,.45)]"
    >
      <div className="flex shrink-0 items-start justify-between gap-3 px-6 pt-5 pb-4">
        <div className="min-w-0">
          {row && (
            <div className="flex items-center gap-2 text-muted type-caption">
              <span>
                {ServiceAreaInfo.label(row.serviceArea, departments)} · {editing ? "Edit project" : "Project detail"}
              </span>
              {editing && headerTag}
            </div>
          )}
          <h2 className="mt-1 type-heading text-base">
            {row ? row.name : "New project"}
            {row?.isMfi && <MfiChip />}
          </h2>
        </div>
        {row && headerAction ? (
          <div className="flex shrink-0 items-center gap-1.5">
            {/* Brief sits directly left of the close button (placement spec 4). */}
            {headerAction}
            {closeButton}
          </div>
        ) : (
          closeButton
        )}
      </div>
      {form ? (
        <>
          {form({ previously: <PreviouslyLine text={history.timeline?.previously} />, trailing, admin: adminControls })}
        </>
      ) : row ? (
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pb-5" data-testid="drawer-readonly">
          <ReadOnlyDetails row={row} today={today} departments={departments} peopleEditor={peopleEditor} previously={history.timeline?.previously} />
          {dependencies}
          {trailing}
          {/* Admin controls at the bottom of the side panel, below History. */}
          {adminControls}
        </div>
      ) : null}
    </aside>
  );
}

/** The read-only fields (non-admins and the Closed pages): what the detail panel showed. */
function ReadOnlyDetails({
  row,
  today,
  departments,
  peopleEditor,
  previously,
}: {
  row: DashboardRow;
  today: string;
  departments?: DepartmentList;
  peopleEditor: ReactNode;
  previously: string | null | undefined;
}) {
  const daysOverdue = row.overdue && row.dueDate ? DateFormat.daysBetween(row.dueDate, today) : 0;
  return (
    <>
      <div className="flex gap-1.5">
        <StatusPill status={row.status} />
        {(row.changed || row.overdue) && <Flags changed={row.changed} overdue={row.overdue} />}
      </div>
      {peopleEditor}
      {/* With the people editor above (its own bottom divider), one divider only: no top border here. */}
      <dl className={`grid grid-cols-[130px_1fr] gap-y-2 border-line type-table ${peopleEditor ? "border-b pb-3" : "border-y py-3"}`}>
        {!peopleEditor && (
          <>
            <dt className="text-muted">Department</dt>
            <dd>{ServiceAreaInfo.label(row.serviceArea, departments)}</dd>
            <dt className="text-muted">Owner</dt>
            <dd>
              <AssigneeText value={row.owner} />
            </dd>
            <dt className="text-muted">{Requester.LABEL}</dt>
            <dd>
              {/* Detail view: say "Not applicable" (primary text) so it differs from a gray "To assign". */}
              {row.requesterNotApplicable && !row.physicianChampion ? Requester.NOT_APPLICABLE : <AssigneeText value={row.physicianChampion} />}
            </dd>
            <dt className="text-muted">Contracts lead</dt>
            <dd>
              <AssigneeText value={row.contractsLead} />
            </dd>
          </>
        )}
        <dt className="text-muted">Infor number</dt>
        <dd>
          <span className="font-mono">{InforNumber.format(row.inforRequestNumber) ?? "–"}</span>
          <PreviouslyLine text={previously} />
        </dd>
        <dt className="text-muted">Next milestone</dt>
        <dd>
          {/* At most 2 lines (count included); the full text is in the tooltip and the Milestones section. */}
          <div className="line-clamp-2 break-words" title={row.nextMilestone?.trim() || undefined} data-testid="drawer-next-milestone">
            {row.nextMilestone?.trim() ? <span className="whitespace-pre-wrap">{row.nextMilestone}</span> : <span className="text-muted">–</span>}
            {MilestoneProgress.progressLabel(row.milestoneProgress) && (
              <span className="ml-1.5 whitespace-nowrap text-muted" data-testid="milestone-progress">
                {MilestoneProgress.progressLabel(row.milestoneProgress)}
              </span>
            )}
          </div>
        </dd>
        {row.startDate !== undefined && (
          <>
            <dt className="text-muted">{StartDate.DETAIL_LABEL}</dt>
            <dd data-testid="start-date">
              {DateFormat.long(row.startDate) ?? "–"}
              {row.startDateIsDefault && <StartDateDefaultTag />}
            </dd>
          </>
        )}
        {/* Completion date right after Start date (task 5). */}
        {row.completion && (
          <>
            <dt className="text-muted">{CompletionCopy.ROW_LABEL}</dt>
            <dd data-testid="completion-date">
              {row.completion.date ? (
                <>
                  {DateFormat.long(row.completion.date)}
                  {row.completion.source && <CompletionTag source={row.completion.source} />}
                </>
              ) : (
                // The Stale chip (dashed amber border, fill, clock icon), text exactly "Completion date needed".
                <span className="inline-flex align-middle" data-testid="completion-date-needed">
                  <DueFlagPill kind="stale" label={CompletionCopy.DATE_NEEDED} />
                </span>
              )}
            </dd>
          </>
        )}
        <dt className="text-muted">Due date</dt>
        <dd className={row.overdue ? "font-semibold text-danger" : ""}>
          {DateFormat.long(row.dueDate) ?? "–"}
          {row.overdue && ` · ${daysOverdue} day${daysOverdue === 1 ? "" : "s"} overdue`}
        </dd>
        <dt className="text-muted">Target completion</dt>
        <dd>{DateFormat.long(row.targetCompletion) ?? "–"}</dd>
        <dt className="text-muted">In report</dt>
        <dd>{row.includeInReport ? "Yes" : "No"}</dd>
      </dl>
      <div>
        {/* Read-only: the note as plain text, no counter and no input-style box. */}
        <div className="mb-1.5 uppercase tracking-[.04em] text-muted type-label">Note</div>
        <p className="break-words whitespace-pre-wrap type-body" data-testid="drawer-note">
          {row.note ?? <span className="text-muted">No note</span>}
        </p>
      </div>
      {/* Read-only for everyone but admins (admins edit it in the form). */}
      <MfiCheckbox checked={Boolean(row.isMfi)} />
    </>
  );
}

/** A new service line with no projects yet: what to set up first. */
function EmptyLineState({ line, admin, onNew }: { line: ServiceLineScope; admin: boolean; onNew: () => void }) {
  const link = "text-accent type-table-strong hover:underline";
  return (
    <section aria-label="Get started" className="flex flex-col gap-3 rounded-card border border-line bg-card px-5 py-4" data-testid="empty-line">
      <div>
        <h2 className="type-heading">No projects in {line.name} yet</h2>
        <p className="mt-1 text-muted type-table">
          {ServiceAreaInfo.all(line.departments).length === 0
            ? "Start by adding its departments. Then add projects one at a time or import a CSV."
            : "Add projects one at a time or import a CSV."}
        </p>
      </div>
      {admin && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <Link href="/admin/departments" className={link}>
            Departments
          </Link>
          <Link href="/admin/people" className={link}>
            Contracts leads
          </Link>
          <Link href="/admin/templates" className={link}>
            Milestone templates
          </Link>
          <Link href="/admin/import" className={link}>
            Import a CSV
          </Link>
          <button type="button" onClick={onNew} className={link}>
            + New project
          </button>
        </div>
      )}
    </section>
  );
}

/** Edit drawer header tag: "Blocked by 2". */
function BlockedByTag({ n }: { n: number }) {
  return (
    <span data-testid="blocked-by-tag" className="rounded-[4px] bg-(--status-at-risk-dark-bg) px-1.5 text-[11px] leading-4 font-medium text-(--status-at-risk-dark-fg)">
      {DependencyCopy.count(n)}
    </span>
  );
}

/** "As it will print" compact switch in the filter bar (the app's .acct-switch), just left of the tiles button. */
function PrintOrderSwitch({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <span className="ml-2 flex h-7 shrink-0 items-center gap-2 whitespace-nowrap text-fg type-caption" data-testid="print-order">
      <button type="button" role="switch" aria-checked={on} aria-labelledby="print-order-label" onClick={() => onChange(!on)} className="acct-switch" data-testid="print-order-switch">
        <span aria-hidden className="acct-thumb" />
      </button>
      <span id="print-order-label" className="cursor-pointer select-none" onClick={() => onChange(!on)}>
        {PrintOrder.LABEL}
      </span>
    </span>
  );
}
