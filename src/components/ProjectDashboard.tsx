"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ServiceArea, ViewContext } from "@/generated/prisma/enums";
import { AppConfig } from "@/lib/config/AppConfig";
import { DashboardViewModel, DateFormat, type DashboardRow } from "@/lib/dashboard/DashboardViewModel";
import { Assignee } from "@/lib/domain/Assignee";
import { InforNumber } from "@/lib/domain/InforNumber";
import { ProjectStatusInfo } from "@/lib/domain/ProjectStatusInfo";
import { ServiceAreaInfo } from "@/lib/domain/ServiceAreaInfo";
import type { StatusCounts } from "@/lib/domain/types";
import { ViewSettings, type ViewColumn, type ViewSettingsByContext, type ViewSettingsValue } from "@/lib/domain/ViewSettings";
import type { PeopleFieldName } from "./ProjectPeopleEditor";
import { Flags, StatusPill } from "./StatusPill";

// Admin-only UI is code-split: the chunks load only when an admin renders them.
const ViewSettingsPicker = dynamic(() => import("./ViewSettingsPicker").then((m) => m.ViewSettingsPicker));
const ProjectAdminControls = dynamic(() => import("./ProjectAdminControls").then((m) => m.ProjectAdminControls));
const ProjectPeopleEditor = dynamic(() => import("./ProjectPeopleEditor").then((m) => m.ProjectPeopleEditor));

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
  /** Champion emails by project id (admin only; not on DashboardRow). */
  championEmails: Record<string, string | null>;
  setPeopleFieldAction: (projectId: string, field: PeopleFieldName, value: string) => Promise<string | null>;
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
  loadError: string | null;
  admin?: AdminDashboardProps;
  signOutAction: () => Promise<void>;
}

interface ColumnSpec {
  header: string;
  /** Tailwind width class for the <col>; empty = flexible. */
  width: string;
  cell: (r: DashboardRow, td: string) => ReactNode;
}

/** Columns that take a table column of their own (inline ones such as the Infor number render in the Project cell). */
type TableColumn = Exclude<ViewColumn, "inforNumber">;

/** Dashboard table columns, rendered in the order and visibility from the dashboard view settings. */
class DashboardColumns {
  static readonly SPECS: Record<TableColumn, ColumnSpec> = {
    // The table renders the project cell itself (selection bar); this is the plain fallback.
    project: { header: "Project", width: "w-[256px]", cell: (r, td) => <td className={td}>{r.name}</td> },
    serviceArea: {
      header: "Service area",
      width: "w-[120px]",
      cell: (r, td) => (
        <td className={td}>
          <span className="area-tag">{ServiceAreaInfo.label(r.serviceArea)}</span>
        </td>
      ),
    },
    owner: { header: "Owner", width: "w-[84px]", cell: (r, td) => <td className={td}><AssigneeText value={r.owner} /></td> },
    physicianChampion: {
      header: "Physician champion",
      width: "w-[164px]",
      cell: (r, td) => (
        <td className={td}>
          <AssigneeText value={r.physicianChampion} />
        </td>
      ),
    },
    status: {
      header: "Status",
      width: "w-[112px]",
      cell: (r, td) => (
        <td className={td}>
          <StatusPill status={r.status} />
        </td>
      ),
    },
    nextMilestone: { header: "Next milestone", width: "w-[170px]", cell: (r, td) => <td className={td}>{r.nextMilestone ?? ""}</td> },
    due: {
      header: "Due date",
      width: "w-[84px]",
      cell: (r, td) => (
        <td className={`${td} ${r.overdue ? "font-semibold text-danger" : ""}`}>{DateFormat.short(r.dueDate) ?? "–"}</td>
      ),
    },
    note: {
      header: "Note",
      width: "",
      cell: (r, td) => (
        <td className={`${td} text-muted`} title={r.note ?? undefined}>
          {r.note ?? ""}
        </td>
      ),
    },
    flags: {
      header: "Flags",
      width: "w-[176px]",
      cell: (r, td) => (
        <td className={td}>
          <div className="flex items-center gap-1">
            <Flags changed={r.changed} overdue={r.overdue} />
          </div>
        </td>
      ),
    },
  };
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
  loadError,
  columns: columnsProp,
  admin,
  signOutAction,
}: Props) {
  const [area, setArea] = useState<ServiceArea | "All">("All");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // Admin only: optimistic copy of the settings (rows refresh from the server after each save).
  const [settings, setSettings] = useState<ViewSettingsByContext | null>(admin?.viewSettings ?? null);

  const summary = useMemo(() => DashboardViewModel.summarize(rows), [rows]);
  const visible = useMemo(() => DashboardViewModel.filter(rows, area, query), [rows, area, query]);
  const visibleColumns = settings ? ViewSettings.visibleColumns(settings.dashboard) : columnsProp;
  const columns = visibleColumns.filter((c): c is TableColumn => !ViewSettings.isInline(c));
  const showInfor = visibleColumns.includes("inforNumber");
  const selected = rows.find((r) => r.id === selectedId) ?? null;

  /** Optimistic: apply locally, persist, roll back on failure. */
  const saveSettings = async (context: ViewContext, value: ViewSettingsValue): Promise<string | null> => {
    if (!admin || !settings) return "Not authorized.";
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (e.key === "/" && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "Escape") {
        setSelectedId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="relative min-h-screen">
      <header className="sticky top-0 z-10 flex h-14 items-center gap-4 border-b border-line bg-topbar px-6 backdrop-blur-[20px]">
        <div className="flex items-center gap-2.5">
          <div className="grid size-[26px] place-items-center rounded-[6px] bg-accent type-label font-bold">SL</div>
          <span className="type-title">Service Line Portfolio</span>
        </div>
        <div className="h-6 w-px bg-line" />
        <button
          type="button"
          disabled
          title="Report history coming soon"
          className="flex h-8 items-center gap-2 rounded-control border border-line bg-input pr-2.5 pl-3 text-muted"
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
        <label className="flex h-8 w-80 shrink-0 items-center gap-2 rounded-control border border-line bg-input pr-2.5 pl-3 text-muted type-table">
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
          <>
            <Link href="/admin/audit" className="type-table-strong text-muted hover:text-fg">
              Audit
            </Link>
            <ViewSettingsPicker settings={settings} counts={admin.pickerCounts} onSave={saveSettings} />
          </>
        )}
        <Link href="/reports" className="type-table-strong text-muted hover:text-fg">
          Reports
        </Link>
        {admin && (
          <a
            href="/api/reports/preview"
            download
            title="Download a draft PDF from live data. Not an official snapshot; nothing is saved or sent."
            className="flex h-8 items-center rounded-control bg-accent px-3.5 text-white type-table-strong"
          >
            Generate PDF now
          </a>
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

        <section className="grid grid-cols-[repeat(7,1fr)_1fr_1.5fr] gap-2" aria-label="Status summary">
          {ProjectStatusInfo.all().map((s) => (
            <div key={s} className="flex flex-col items-start gap-1.5 rounded-card border border-line bg-card px-3 py-2.5">
              <div className="type-metric">{summary.byStatus[s]}</div>
              <StatusPill status={s} />
            </div>
          ))}
          <div className="flex flex-col items-start gap-1.5 rounded-card border border-line bg-card px-3 py-2.5">
            <div className="type-metric">{summary.overdue}</div>
            <span className="flag fl-overdue">! Overdue</span>
          </div>
          <div className="flex flex-col items-start gap-1.5 rounded-card border border-line bg-card px-3 py-2.5">
            <div className="type-metric">{summary.changed}</div>
            <span className="flag fl-changed">◆ Changed since last report</span>
          </div>
        </section>

        <section className="flex items-center gap-1.5" aria-label="Service area filter">
          <button type="button" className="chip" aria-pressed={area === "All"} onClick={() => setArea("All")}>
            All <b>{summary.total}</b>
          </button>
          {ServiceAreaInfo.all().map((a) => (
            <button key={a} type="button" className="chip" aria-pressed={area === a} onClick={() => setArea(a)}>
              {ServiceAreaInfo.label(a)} <b>{summary.byArea[a]}</b>
            </button>
          ))}
          <div className="flex-1" />
          <span className="type-caption text-muted">Showing {visible.length} projects</span>
        </section>

        <section className="overflow-hidden rounded-card border border-line bg-card">
          <div className="max-h-[calc(100vh-260px)] overflow-auto">
            <table className="w-full table-fixed border-separate border-spacing-0 type-table">
              <colgroup>
                {columns.map((c) => (
                  <col key={c} className={DashboardColumns.SPECS[c].width || undefined} />
                ))}
              </colgroup>
              <thead>
                <tr>
                  {columns.map((c) => (
                    <th
                      key={c}
                      className="sticky top-0 z-[1] h-9 truncate border-b border-line bg-card px-3 text-left uppercase tracking-[.04em] text-muted type-label"
                    >
                      {DashboardColumns.SPECS[c].header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.length === 0 && (
                  <tr>
                    <td colSpan={columns.length} className="h-20 text-center text-muted">
                      {rows.length === 0 ? "No projects yet." : "No projects match the current filter."}
                    </td>
                  </tr>
                )}
                {visible.map((r) => {
                  const isSel = r.id === selectedId;
                  const td = `h-10 truncate border-b border-line px-3 align-middle ${isSel ? "bg-row-selected" : ""}`;
                  return (
                    <tr
                      key={r.id}
                      onClick={() => setSelectedId(isSel ? null : r.id)}
                      className="cursor-pointer hover:[&>td]:bg-row-selected/60"
                      aria-selected={isSel}
                    >
                      {columns.map((c) =>
                        c === "project" ? (
                          <td
                            key={c}
                            className={`${td} type-table-strong ${isSel ? "shadow-[inset_3px_0_0_var(--dark-accent)]" : ""}`}
                          >
                            <div className="truncate">{r.name}</div>
                            <ProjectMetaLine row={r} showInfor={showInfor} />
                          </td>
                        ) : (
                          <Fragment key={c}>{DashboardColumns.SPECS[c].cell(r, td)}</Fragment>
                        ),
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex justify-between border-t border-line px-3 py-2.5 text-muted type-caption">
            <span>
              {visible.length} of {rows.length} projects
            </span>
            <span>Changed = any edit since the last report</span>
          </div>
        </section>
      </main>

      {selected && (
        <ProjectDrawer
          row={selected}
          today={today}
          onClose={() => setSelectedId(null)}
          peopleEditor={
            admin ? (
              <ProjectPeopleEditor
                key={selected.id}
                projectId={selected.id}
                owner={selected.owner}
                physicianChampion={selected.physicianChampion}
                physicianChampionEmail={admin.championEmails[selected.id] ?? null}
                serviceArea={selected.serviceArea}
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
                onGone={() => setSelectedId(null)}
              />
            ) : null
          }
        />
      )}
    </div>
  );
}

/**
 * Owner or champion name, or "To assign" when blank: regular weight, same size as a name, in the secondary
 * text color (--dark-text-secondary). Not a warning, so no amber, icon or chip.
 */
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
  peopleEditor,
  adminControls,
}: {
  row: DashboardRow;
  today: string;
  onClose: () => void;
  /** Admin-only edit panel (owner, champion, department), shown at the top. Null for non-admins. */
  peopleEditor: ReactNode;
  /** Rendered only for admins. */
  adminControls: ReactNode;
}) {
  const daysOverdue = row.overdue && row.dueDate ? DateFormat.daysBetween(row.dueDate, today) : 0;
  return (
    <aside
      aria-label="Project detail"
      className="fixed top-[208px] right-6 bottom-6 z-20 flex w-[440px] flex-col gap-4 overflow-y-auto rounded-card border border-line bg-card px-6 py-5 shadow-[-16px_0_40px_rgba(0,0,0,.45)]"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-muted type-caption">{ServiceAreaInfo.label(row.serviceArea)} · Project detail</div>
          <h2 className="mt-1 type-heading text-base">{row.name}</h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="size-7 rounded-[6px] border border-line text-xs text-muted hover:text-fg"
        >
          ✕
        </button>
      </div>
      <div className="flex gap-1.5">
        <StatusPill status={row.status} />
        {(row.changed || row.overdue) && <Flags changed={row.changed} overdue={row.overdue} />}
      </div>
      {peopleEditor}
      <dl className="grid grid-cols-[130px_1fr] gap-y-2 border-y border-line py-3 type-table">
        {!peopleEditor && (
          <>
            <dt className="text-muted">Department</dt>
            <dd>{ServiceAreaInfo.label(row.serviceArea)}</dd>
            <dt className="text-muted">Owner</dt>
            <dd>
              <AssigneeText value={row.owner} />
            </dd>
            <dt className="text-muted">Physician champion</dt>
            <dd>
              <AssigneeText value={row.physicianChampion} />
            </dd>
          </>
        )}
        <dt className="text-muted">Infor request #</dt>
        <dd className="font-mono">{InforNumber.format(row.inforRequestNumber) ?? "–"}</dd>
        <dt className="text-muted">Next milestone</dt>
        <dd>{row.nextMilestone ?? ""}</dd>
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
      <div>
        <div className="mb-1.5 flex items-baseline gap-2 uppercase tracking-[.04em] text-muted type-label">
          History
          <span className="normal-case tracking-normal type-caption">Append-only · entries can’t be edited</span>
        </div>
        {/* STUB: history timeline (ProjectHistory rows) not wired up yet. */}
        <p className="text-muted type-caption">History timeline coming soon.</p>
      </div>
      {adminControls}

    </aside>
  );
}
