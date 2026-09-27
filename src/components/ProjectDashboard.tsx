"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ViewContext } from "@/generated/prisma/enums";
import { AppConfig } from "@/lib/config/AppConfig";
import { DashboardViewModel, DateFormat, type DashboardRow } from "@/lib/dashboard/DashboardViewModel";
import type { DashboardFyRow } from "@/lib/dashboard/FiscalYearSections";
import { Assignee } from "@/lib/domain/Assignee";
import { Requester } from "@/lib/domain/Requester";
import { PreviouslyLine, ProjectHistorySection, useProjectTimeline, type HistoryLoader } from "./ProjectHistory";
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
import type { ProjectFormSubmit } from "./ProjectEditForm";
import type { MilestoneSaveActionResult } from "@/app/actions/admin";
import { ServiceLineLabel } from "./ServiceLineLabel";
import type { PeopleFieldName } from "./ProjectPeopleEditor";
import { DashboardTable, type DashboardLayoutControl } from "./DashboardTable";
import { FiscalYearSectionsView } from "./FiscalYearSections";
import { DashboardSort, type DashboardSortKey } from "@/lib/dashboard/DashboardSort";
import { LayoutCopy, LineLayout, type ColumnLayoutValue, type LineLayoutValue } from "@/lib/layout/LineLayout";
import type { AreaGroup } from "@/lib/domain/ServiceAreaInfo";
import { DepartmentsSelect, TileVisibilityButton } from "./DashboardFilterControls";
import { OnDemandPdfLink } from "@/lib/report/OnDemandPdfLink";
import { DashboardPrefs, type DashboardTile } from "@/lib/dashboard/DashboardPrefs";
import { DepartmentFilter } from "@/lib/domain/DepartmentFilter";
import { Flags, StatusPill } from "./StatusPill";

// Admin-only UI is code-split: the chunks load only when an admin renders them.
const ViewSettingsPicker = dynamic(() => import("./ViewSettingsPicker").then((m) => m.ViewSettingsPicker));
const ProjectAdminControls = dynamic(() => import("./ProjectAdminControls").then((m) => m.ProjectAdminControls));
const ProjectPeopleEditor = dynamic(() => import("./ProjectPeopleEditor").then((m) => m.ProjectPeopleEditor));
const AdminMenuButton = dynamic(() => import("./AdminMenuButton").then((m) => m.AdminMenuButton));
const ProjectEditForm = dynamic(() => import("./ProjectEditForm").then((m) => m.ProjectEditForm));

export interface LatestReport {
  /** YYYY-MM-DD */
  reportDate: string;
  periodStart: string;
  periodEnd: string;
}

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
  /** New project drawer: create (name and department required), with its checklist. */
  createProjectAction: (values: Partial<ProjectFormValues>, milestones: MilestoneEdit | null) => ReturnType<ProjectFormSubmit>;
  /** Line layout: save column order and width shares (null = reset columns). */
  saveColumnLayoutAction: (columns: ColumnLayoutValue | null) => Promise<string | null>;
  /** Line layout: one department's manual order (empty = report order there). */
  saveRowOrderAction: (area: string, ids: string[]) => Promise<string | null>;
  /** Line layout: reset the manual order in every department. */
  resetRowOrderAction: () => Promise<string | null>;
}

/** Admin drawer mode: detail view, edit form, or the empty New project form. */
export type DrawerMode = "view" | "edit" | "new";

/** How long a newly created project's row stays highlighted after it scrolls into view. */
export class NewRowFlash {
  static readonly MS = 1500;
}

interface Props {
  /** Already filtered by VisibilityPolicy on the server. */
  rows: DashboardRow[];
  /** Completed and Cancelled rows of every fiscal year (FY sections below the department groups). */
  fiscalYearRows?: DashboardFyRow[];
  /** Visible dashboard columns in order. */
  columns: ViewColumn[];
  today: string;
  userEmail: string;
  userName: string | null;
  latestReport: LatestReport | null;
  /** "Completed FY27 to date N": the current year's Completed section count (dashboard visibility). */
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
  /** A project link (/?project=<id>) the server checked: its detail opens on load. */
  initialProjectId?: string;
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
  fiscalYearRows = [],
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
  initialProjectId,
}: Props) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(initialProjectId ?? null);
  const searchRef = useRef<HTMLInputElement>(null);
  // Admin edit mode. Non-admins stay in "view" (there is no way to switch).
  const [mode, setMode] = useState<DrawerMode>("view");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const dirtyRef = useRef(false);
  const pendingRef = useRef<(() => void) | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const scrollToRef = useRef<string | null>(null);
  // Admin only: optimistic copy of the settings (rows refresh from the server after each save).
  const [settings, setSettings] = useState<ViewSettingsByContext | null>(admin?.viewSettings ?? null);

  // Line layout (server side, shared by everyone on the line). Admin changes apply optimistically and roll back on failure.
  const [lineLayout, setLineLayout] = useState<LineLayoutValue>(layoutProp ?? LineLayout.defaults());
  const [layoutError, setLayoutError] = useState<string | null>(null);
  const [sort, setSort] = useState<DashboardSortKey>("manual");
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
  useEffect(() => {
    const storage = DashboardPrefsBrowser.storage();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-time read of browser-only storage after hydration
    setDepartmentsState(DashboardPrefs.readDepartments(storage, userEmail, line));
    setHiddenTilesState(DashboardPrefs.readHiddenTiles(storage, userEmail, line));
  }, [userEmail, line]);
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
  // The FY sections follow the same department filter and search as the rows.
  const deptFy = useMemo(() => DepartmentFilter.apply(fiscalYearRows, departments, deptOptions), [fiscalYearRows, departments, deptOptions]);
  const summary = useMemo(() => DashboardViewModel.summarize(deptRows), [deptRows]);
  const visible = useMemo(() => DashboardViewModel.filter(deptRows, query), [deptRows, query]);
  const visibleFy = useMemo(() => DashboardViewModel.filter(deptFy, query), [deptFy, query]);
  const tiles = DashboardPrefs.visibleTiles(hiddenTiles, Boolean(completedFiscalYear));
  const tileTemplate = DashboardPrefs.gridTemplate(tiles);
  const emptyLine = DashboardViewModel.isEmptyLine(line, rows.length + fiscalYearRows.length, Boolean(loadError));
  // Non-admins get only the visible columns in order; that is the same model with nothing hidden.
  const dashboardView: ViewSettingsValue = settings?.dashboard ?? { columnOrder: columnsProp, hiddenColumns: [], hiddenStatuses: [] };
  const showInfor = ViewSettings.visibleColumns(dashboardView).includes("inforNumber");
  const selected = rows.find((r) => r.id === selectedId) ?? fiscalYearRows.find((r) => r.id === selectedId) ?? null;

  /** Optimistic: apply locally, persist, roll back on failure. */
  const saveSettings = async (context: ViewContext, value: ViewSettingsValue): Promise<string | null> => {
    if (!admin || !settings) return "Not authorized.";
    if (context === "dashboard" && lineLayout.columns) {
      // This line has its own column order: a reorder in the View menu changes the line layout (not the order
      // shared by every line); show/hide still saves to the dashboard view settings.
      const order = LineLayout.orderFromSettings("dashboard", value);
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
      return "Could not save view settings.";
    }
  };

  const onDirtyChange = useCallback((dirty: boolean) => {
    dirtyRef.current = dirty;
  }, []);

  /** Run `action` now, or first ask "Discard changes?" when the edit form has unsaved changes. */
  const guard = (action: () => void) => {
    if (mode !== "view" && dirtyRef.current) {
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
      setMode("view");
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
    leaveForm();
    setMode("view");
    if (created && id) {
      // Show the new project whatever the current filter, then scroll its row into view.
      setQuery("");
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (e.key === "/" && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "Escape") {
        escRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="relative min-h-screen">
      <header className="sticky top-0 z-10 flex h-14 items-center gap-4 border-b border-line bg-topbar px-6 backdrop-blur-[20px]">
        <div className="flex shrink-0 items-center gap-2.5">
          <div className="grid size-[26px] shrink-0 place-items-center rounded-[6px] bg-accent type-label font-bold">SL</div>
          {switcher ?? <ServiceLineLabel value={serviceLine} />}
        </div>
        <div className="h-6 w-px bg-line" />
        <button
          type="button"
          disabled
          title="Report history coming soon"
          className="flex h-8 shrink-0 items-center gap-2 rounded-control border border-line bg-input pr-2.5 pl-3 whitespace-nowrap text-muted"
        >
          {latestReport ? (
            <>
              <span className="type-table-strong text-fg">Report of {DateFormat.short(latestReport.reportDate)}</span>
              <span className="type-caption">
                {DateFormat.short(latestReport.periodStart)} – {DateFormat.long(latestReport.periodEnd)}
              </span>
            </>
          ) : (
            <span className="type-table-strong text-fg">No reports yet</span>
          )}
        </button>
        <div className="flex-1" />
        <label className="flex h-8 w-80 min-w-40 shrink items-center gap-2 rounded-control border border-line bg-input pr-2.5 pl-3 text-muted type-table">
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
            <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M9.5 9.5L13 13" stroke="currentColor" strokeWidth="1.5" />
          </svg>
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search projects, owners, physicians…"
            aria-label="Search projects"
            className="min-w-0 flex-1 bg-transparent text-fg placeholder:text-muted focus:outline-none"
          />
          <kbd className="rounded border border-line px-1 type-caption">/</kbd>
        </label>
        {admin && settings && (
          <ViewSettingsPicker
            settings={lineLayout.columns ? { ...settings, dashboard: LineLayout.orderedSettings("dashboard", settings.dashboard, lineLayout.columns.order) } : settings}
            counts={admin.pickerCounts}
            onSave={saveSettings}
            layoutReset={{ shortName: serviceLine.shortName, onResetColumns: () => saveColumns(null), onResetRows: resetRows }}
          />
        )}
        <Link href="/reports" className="shrink-0 whitespace-nowrap type-table-strong text-muted hover:text-fg">
          Reports
        </Link>
        {/* Everyone who can see the dashboard. Admins: as before. Everyone else: only the departments they are
            viewing (the server keeps only ones they can see; DraftReportService). */}
        <a
          href={admin ? OnDemandPdfLink.href() : OnDemandPdfLink.href(departments)}
          download
          title={OnDemandPdfLink.TOOLTIP}
          className="flex h-8 shrink-0 items-center rounded-control bg-accent px-3.5 whitespace-nowrap text-white type-table-strong"
        >
          Generate PDF now
        </a>
        {admin && admin.menuItems.length > 0 && (
          // 12px left of the user block (header gap is 16px).
          <div className="-mr-1">
            <AdminMenuButton items={admin.menuItems} />
          </div>
        )}
        <form action={signOutAction} className="flex items-center gap-2 text-muted">
          <div className="grid size-[30px] place-items-center rounded-full border border-(--status-on-hold-dark-fg) bg-(--status-on-hold-dark-bg) type-label font-semibold text-(--status-on-hold-dark-fg)">
            {Initials.of(userName, userEmail)}
          </div>
          <div className="flex flex-col type-caption">
            <b className="type-label text-fg">{userName ?? userEmail}</b>
            <button type="submit" className="text-left hover:text-fg">
              Sign out
            </button>
          </div>
        </form>
      </header>

      <main className="flex flex-col gap-4 px-6 pt-5 pb-6">
        {loadError && (
          <p role="alert" className="rounded-card border border-line bg-card px-3 py-2 text-danger">
            {loadError}
          </p>
        )}

        {emptyLine && <EmptyLineState line={line!} admin={Boolean(admin)} onNew={openNew} />}

        {/* A line with no projects shows only the banner; tiles, toolbar and table appear with the first project. */}
        {!emptyLine && tileTemplate && (
          <section className="grid gap-2" style={{ gridTemplateColumns: tileTemplate }} aria-label="Status summary">
            {tiles.map((t) =>
              t === "completedFy" ? (
                completedFiscalYear && <CompletedFiscalYearCard key={t} fy={completedFiscalYear} />
              ) : (
                <div key={t} data-tile={t} className="flex min-w-0 flex-col items-start gap-1.5 rounded-card border border-line bg-card px-3 py-2.5">
                  <div className="type-metric">{summary.byStatus[t]}</div>
                  <StatusPill status={t} />
                </div>
              ),
            )}
          </section>
        )}

        {!emptyLine && (
        <section className="flex items-center gap-1.5" aria-label="Department filter">
          <div className="flex-1" />
          {layoutError && (
            <span role="alert" className="mr-2 text-danger type-caption">
              {layoutError}
            </span>
          )}
          <span className="type-caption text-muted">Showing {visible.length} projects</span>
          <label className="ml-2 flex h-7 items-center gap-1.5 rounded-control border border-line bg-input pr-1 pl-2.5 text-muted type-table">
            Sort
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as DashboardSortKey)}
              aria-label="Sort projects"
              data-testid="sort-menu"
              className="h-6 bg-transparent text-fg type-table-strong focus:outline-none"
            >
              {DashboardSort.OPTIONS.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <div className="ml-2">
            <DepartmentsSelect value={departments} onChange={setDepartments} options={deptOptions} list={line?.departments} limited={Boolean(line?.departmentLimit)} />
          </div>
          {admin && (
            <button
              type="button"
              onClick={openNew}
              className="ml-2 flex h-7 shrink-0 items-center rounded-control bg-accent px-3 whitespace-nowrap text-white type-table-strong"
            >
              + New project
            </button>
          )}
          <TileVisibilityButton
            tiles={DashboardPrefs.availableTiles(Boolean(completedFiscalYear))}
            hidden={hiddenTiles}
            labelOf={(t) => (t === "completedFy" ? DashboardPrefs.tileLabel(t, completedFiscalYear?.label ?? null) : <span className={`pill st-${t}`}>{ProjectStatusInfo.label(t)}</span>)}
            onChange={setHiddenTiles}
          />
        </section>
        )}

        {!emptyLine && (
        <section className="overflow-hidden rounded-card border border-line bg-card">
          <div className="max-h-[calc(100vh-260px)] overflow-auto">
            <DashboardTable
              rows={visible}
              settings={dashboardView}
              selectedId={selectedId}
              flashId={flashId}
              onSelect={selectRow}
              today={today}
              emptyText={rows.length === 0 && fiscalYearRows.length === 0 ? "No projects yet." : "No projects match the current filter."}
              renderMeta={(r) => <ProjectMetaLine row={r} showInfor={showInfor} />}
              layout={layoutControl}
              departments={line?.departments}
            />
            <FiscalYearSectionsView
              rows={visibleFy}
              allRows={fiscalYearRows}
              today={today}
              departments={line?.departments}
              selectedId={selectedId}
              onSelect={selectRow}
              renderMeta={(r) => <ProjectMetaLine row={r} showInfor={showInfor} />}
            />
          </div>
          <div className="flex justify-between border-t border-line px-3 py-2.5 text-muted type-caption">
            <span>
              {visible.length} of {rows.length} projects
            </span>
            <span>Changed = any edit since the last report</span>
          </div>
        </section>
        )}
      </main>

      {mode === "new" && admin ? (
        <ProjectDrawer
          row={null}
          departments={line?.departments}
          today={today}
          onClose={requestClose}
          peopleEditor={null}
          adminControls={null}
          form={
            <ProjectEditForm
              key="new"
              mode="new"
              {...(line ? { departments: line.departments } : {})}
              original={ProjectFormModel.empty()}
              milestones={[]}
              templates={admin.templates}
              checkerName={admin.checkerName}
              today={today}
              people={null}
              adminDelete={null}
              onSubmit={admin.createProjectAction}
              onSaved={onSaved}
              onCancel={requestClose}
              onDirtyChange={onDirtyChange}
              confirmDiscard={confirmDiscard}
              onKeepEditing={() => setConfirmDiscard(false)}
              onDiscard={discard}
            />
          }
        />
      ) : (
        selected && (
          <ProjectDrawer
            row={selected}
            historyAction={historyAction}
            departments={line?.departments}
            today={today}
            onClose={requestClose}
            onEdit={admin && mode === "view" && admin.formValues[selected.id] ? () => setMode("edit") : undefined}
            peopleEditor={
              admin ? (
                <ProjectPeopleEditor
                  key={selected.id}
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
              admin && mode === "edit" && admin.formValues[selected.id] ? (
                <ProjectEditForm
                  key={`edit-${selected.id}`}
                  mode="edit"
                  {...(line ? { departments: line.departments } : {})}
                  original={admin.formValues[selected.id]}
                  milestones={admin.milestoneSteps[selected.id] ?? []}
                  checkerName={admin.checkerName}
                  templates={admin.templates}
                  today={today}
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
                  onSubmit={(changes, milestones) => admin.saveProjectFormAction(selected.id, changes, milestones)}
                  saveMilestones={(edit) => admin.saveMilestonesAction(selected.id, edit)}
                  onSaved={onSaved}
                  onCancel={() =>
                    guard(() => {
                      leaveForm();
                      setMode("view");
                    })
                  }
                  onDirtyChange={onDirtyChange}
                  confirmDiscard={confirmDiscard}
                  onKeepEditing={() => setConfirmDiscard(false)}
                  onDiscard={discard}
                />
              ) : null
            }
          />
        )
      )}
    </div>
  );
}

/**
 * Owner or requester name, or "To assign" when blank: regular weight, same size as a name, in the secondary
 * text color (--dark-text-secondary). Not a warning, so no amber, icon or chip.
 */
/** Summary strip card: teal check and count, "Completed FY27 to date" under it. */
export function CompletedFiscalYearCard({ fy }: { fy: FiscalYearCount }) {
  return (
    <div data-testid="completed-fy" className="flex flex-col items-start gap-1.5 rounded-card border border-line bg-card px-3 py-2.5">
      <div className="type-metric text-(--status-on-track-dark-fg)">{fy.count}</div>
      <span className="type-caption text-(--status-on-track-dark-fg)">&#10003; {FiscalYear.completedLabel(fy.label)}</span>
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
 * every row. No number: the slot and gap stay, blank (no dash). Column hidden in the view settings: no
 * slot and no gap, so "Updated" starts at the left edge. Stale amber applies to the Updated date only.
 */
export function ProjectMetaLine({ row, showInfor }: { row: DashboardRow; showInfor: boolean }) {
  const updated = DateFormat.short(row.updatedOn);
  const req = InforNumber.format(row.inforRequestNumber);
  if (!updated && !(showInfor && req)) return null;
  return (
    <div className="truncate text-[10px] leading-3 font-normal text-muted">
      {showInfor && (
        <span
          data-testid="infor-slot"
          className="font-mono text-[9px] text-[#B8BEC8]"
          style={{ display: "inline-block", width: DashboardMetaLine.INFOR_SLOT_WIDTH, marginRight: DashboardMetaLine.INFOR_GAP, textAlign: "left" }}
        >
          {req ?? ""}
        </span>
      )}
      {updated && (
        <span className={row.stale ? "font-medium text-(--status-at-risk-dark-fg)" : undefined}>Updated {updated}</span>
      )}
    </div>
  );
}

function ProjectDrawer({
  row,
  today,
  onClose,
  onEdit,
  peopleEditor,
  adminControls,
  form,
  departments,
  historyAction,
}: {
  /** Null for the New project form. */
  row: DashboardRow | null;
  /** Loads the History section and the "Previously" Infor numbers (detail view only). */
  historyAction?: HistoryLoader;
  /** The line's departments (the department's short name in the header and detail). */
  departments?: DepartmentList;
  today: string;
  onClose: () => void;
  /** Admins only: shows the Edit button left of close. */
  onEdit?: () => void;
  /** Admin edit form (edit or New project). When set, the drawer shows it with a pinned footer. */
  form?: ReactNode;
  /** Admin-only edit panel (owner, requester, department), shown at the top. Null for non-admins. */
  peopleEditor: ReactNode;
  /** Rendered only for admins. */
  adminControls: ReactNode;
}) {
  const history = useProjectTimeline(row?.id ?? "", row, row && !form ? historyAction : undefined);
  const closeButton = (
    <button
      type="button"
      onClick={onClose}
      aria-label="Close"
      className="size-7 rounded-[6px] border border-line text-xs text-muted hover:text-fg"
    >
      ✕
    </button>
  );
  if (form || !row) {
    // Edit form: header, scrolling fields, footer pinned to the drawer bottom.
    return (
      <aside
        aria-label={row ? "Edit project" : "New project"}
        className="fixed top-[208px] right-6 bottom-6 z-20 flex w-[440px] flex-col overflow-hidden rounded-card border border-line bg-card shadow-[-16px_0_40px_rgba(0,0,0,.45)]"
      >
        <div className="flex shrink-0 items-start justify-between gap-3 px-6 pt-5 pb-4">
          <div className="min-w-0">
            {row && <div className="text-muted type-caption">{ServiceAreaInfo.label(row.serviceArea, departments)} · Edit project</div>}
            <h2 className="mt-1 type-heading text-base">{row ? row.name : "New project"}</h2>
          </div>
          {closeButton}
        </div>
        {form}
      </aside>
    );
  }
  const daysOverdue = row.overdue && row.dueDate ? DateFormat.daysBetween(row.dueDate, today) : 0;
  return (
    <aside
      aria-label="Project detail"
      className="fixed top-[208px] right-6 bottom-6 z-20 flex w-[440px] flex-col gap-4 overflow-y-auto rounded-card border border-line bg-card px-6 py-5 shadow-[-16px_0_40px_rgba(0,0,0,.45)]"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-muted type-caption">{ServiceAreaInfo.label(row.serviceArea, departments)} · Project detail</div>
          <h2 className="mt-1 type-heading text-base">{row.name}</h2>
        </div>
        {onEdit ? (
          <div className="flex shrink-0 items-center gap-1.5">
            <button type="button" onClick={onEdit} className="h-7 rounded-[6px] px-2.5 text-muted type-table-strong hover:bg-input hover:text-fg">
              Edit
            </button>
            {closeButton}
          </div>
        ) : (
          closeButton
        )}
      </div>
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
          <PreviouslyLine text={history.timeline?.previously} />
        </dd>
        <dt className="text-muted">Next milestone</dt>
        <dd>
          {row.nextMilestone?.trim() ? row.nextMilestone : <span className="text-muted">–</span>}
          {MilestoneProgress.progressLabel(row.milestoneProgress) && (
            <span className="ml-1.5 whitespace-nowrap text-muted" data-testid="milestone-progress">
              {MilestoneProgress.progressLabel(row.milestoneProgress)}
            </span>
          )}
        </dd>
        <dt className="text-muted">Due date</dt>
        <dd className={row.overdue ? "font-semibold text-danger" : ""}>
          {DateFormat.long(row.dueDate) ?? "–"}
          {row.overdue && ` · ${daysOverdue} day${daysOverdue === 1 ? "" : "s"} overdue`}
        </dd>
        <dt className="text-muted">Target completion</dt>
        <dd>{DateFormat.long(row.targetCompletion) ?? "–"}</dd>
        <dt className="text-muted">% complete</dt>
        <dd>{row.percentComplete ?? "–"}</dd>
        <dt className="text-muted">In report</dt>
        <dd>{row.includeInReport ? "Yes" : "No"}</dd>
      </dl>
      <div>
        <div className="mb-1.5 flex items-baseline gap-2 uppercase tracking-[.04em] text-muted type-label">
          Note
          <span className="normal-case tracking-normal type-caption">
            ({row.note?.length ?? 0}/{AppConfig.NOTE_MAX_LENGTH})
          </span>
        </div>
        <p className="rounded-[6px] border border-line bg-input px-3 py-2.5 type-body">
          {row.note ?? <span className="text-muted">No note</span>}
        </p>
      </div>
      {adminControls}
      {historyAction && <ProjectHistorySection key={row.id} timeline={history.timeline} loading={history.loading} />}

    </aside>
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
