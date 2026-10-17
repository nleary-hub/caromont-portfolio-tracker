"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { DependencyActionResult } from "@/app/actions/dependencies";
import type { ProjectStatus } from "@/generated/prisma/enums";
import { ProjectStatusInfo } from "@/lib/domain/ProjectStatusInfo";
import { PeopleComboboxModel } from "@/lib/people/PeopleComboboxModel";
import { BlockerRules } from "@/lib/projects/BlockerRules";
import { DependencyCopy } from "@/lib/projects/DependencyCopy";
import type { BlockerDto, BlockerInput, DependencyInput, DependencyProjectDto, DependencyRowDto, DependencyView } from "@/lib/services/ProjectDependencyService";
import { AiAlert } from "./AiNoteAssistant";
import { DueDatePopover } from "./DueDatePopover";
import { Chevron, FieldControlStyle } from "./FieldControl";
import { PickerSelect } from "./PickerSelect";

/** Server actions for one project's dependencies and blockers; each resolves to the fresh view or a message. */
export interface DependencyActions {
  load: (projectId: string) => Promise<DependencyActionResult>;
  add: (projectId: string, blockedById: string, input?: DependencyInput) => Promise<DependencyActionResult>;
  update: (projectId: string, blockedById: string, input: DependencyInput) => Promise<DependencyActionResult>;
  /** `viewFor`: the drawer's project when removing a Blocking row (the edge is stored on the other project). */
  remove: (projectId: string, blockedById: string, viewFor?: string) => Promise<DependencyActionResult>;
  addBlocker: (projectId: string, input: BlockerInput) => Promise<DependencyActionResult>;
  updateBlocker: (projectId: string, blockerId: string, input: BlockerInput) => Promise<DependencyActionResult>;
  resolveBlocker: (projectId: string, blockerId: string, resolution: string) => Promise<DependencyActionResult>;
}

const STATUS_VAR: Record<ProjectStatus, string> = {
  NotStarted: "--status-not-started-dark-fg",
  OnTrack: "--status-on-track-dark-fg",
  AtRisk: "--status-at-risk-dark-fg",
  OffTrack: "--status-off-track-dark-fg",
  OnHold: "--status-on-hold-dark-fg",
  Complete: "--status-complete-dark-fg",
  Cancelled: "--status-cancelled-dark-fg",
};
const AMBER = "var(--status-at-risk-dark-fg)";
const LABEL = "uppercase tracking-[.04em] text-muted type-label";
const SUB = "text-muted type-caption";
const GHOST = "inline-flex h-7 w-fit items-center gap-1 rounded-control px-1.5 text-accent type-table-strong hover:bg-white/5 disabled:opacity-50";
const INPUT = "block h-8 w-full min-w-0 rounded-control border border-line bg-input px-2 text-fg type-table placeholder:text-muted focus:border-accent focus:outline-none";
const ICON = "grid size-6 place-items-center rounded-[4px] text-muted hover:bg-white/5 hover:text-fg disabled:opacity-50";

type Form =
  | { kind: "project"; editing?: DependencyRowDto }
  | { kind: "external"; editing?: BlockerDto }
  | null;

/**
 * Drawer "Dependencies & blockers" (Figma Bro spec, Oct 17, 2026; replaces DependenciesEditor). One section with an
 * open-count chip: Projects ("Blocked by", then "Blocking") and External blockers, with a collapsed "Resolved (N)"
 * list. Every change goes through a server action that writes history in the same transaction. Read-only
 * (`view.canEdit` false): the same layout without add buttons or hover actions; the resolved list still opens.
 */
export function DependenciesSection({
  projectId,
  actions,
  onCount,
  onOpenProject,
  initialView,
}: {
  projectId: string;
  /** Only `load` is used when the view is read-only. */
  actions: Pick<DependencyActions, "load"> & Partial<DependencyActions>;
  /** Open blocked-by count (the drawer header tag). */
  onCount?: (n: number) => void;
  /** Clicking a Blocking row opens that project's drawer. */
  onOpenProject?: (id: string) => void;
  /** Test and screenshot fixtures: start from this view without loading. */
  initialView?: DependencyView;
}) {
  const [view, setView] = useState<DependencyView | null>(initialView ?? null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<Form>(null);
  const [resolving, setResolving] = useState<BlockerDto | null>(null);
  const [showResolved, setShowResolved] = useState(false);

  // Keyed on the load function, not the actions object (callers may pass a fresh object each render).
  const load = actions.load;
  useEffect(() => {
    if (initialView) return;
    let live = true;
    load(projectId).then(
      (r) => {
        if (!live) return;
        if (r.ok) setView(r.view);
        else setLoadError(r.error);
      },
      () => live && setLoadError(DependencyCopy.LOAD_ERROR),
    );
    return () => {
      live = false;
    };
  }, [projectId, load, initialView]);
  useEffect(() => {
    if (view) onCount?.(view.blockedBy.length);
  }, [view, onCount]);

  /** Runs a write; returns the error message for the form to show inline, or null on success. */
  const run = async (p: Promise<DependencyActionResult> | undefined, inline = false): Promise<{ error: string; kind?: string } | null> => {
    if (!p) return null;
    setBusy(true);
    setSaveError(null);
    try {
      const r = await p;
      if (r.ok) {
        setView(r.view);
        return null;
      }
      if (inline && (r.kind === "rule" || r.kind === "input")) return { error: r.error, kind: r.kind };
      setSaveError(r.kind === "save" || !r.error ? DependencyCopy.SAVE_ERROR : r.error);
      return { error: r.error, kind: r.kind };
    } catch {
      setSaveError(DependencyCopy.SAVE_ERROR);
      return { error: DependencyCopy.SAVE_ERROR, kind: "save" };
    } finally {
      setBusy(false);
    }
  };

  const canEdit = Boolean(view?.canEdit && actions.add);
  return (
    <section aria-labelledby={`deps-title-${projectId}`} className="flex flex-col gap-3" data-testid="dependencies">
      <div className="flex items-center gap-2">
        <h3 id={`deps-title-${projectId}`} className={LABEL}>
          {DependencyCopy.TITLE}
        </h3>
        {view && view.openCount > 0 && (
          <span data-testid="deps-open-chip" className="rounded-pill bg-(--status-at-risk-dark-bg) px-1.5 text-[11px] leading-4 font-medium text-(--status-at-risk-dark-fg)">
            {DependencyCopy.open(view.openCount)}
          </span>
        )}
      </div>
      {saveError && <AiAlert tone="danger" testId="deps-save-error">{saveError}</AiAlert>}
      {!view ? (
        <p className="text-muted type-table">{loadError ?? DependencyCopy.LOADING}</p>
      ) : (
        <>
          <div className="flex flex-col gap-1.5" data-testid="deps-projects">
            <div className={SUB}>{DependencyCopy.BLOCKED_BY}</div>
            {view.blockedBy.length === 0 ? (
              <p className="text-muted type-table" data-testid="dependencies-none">
                {DependencyCopy.NONE}
              </p>
            ) : (
              <ul className="flex flex-col" data-testid="blocked-by-list">
                {view.blockedBy.map((d) => (
                  <DependencyRow
                    key={d.project.id}
                    row={d}
                    canEdit={canEdit}
                    busy={busy}
                    onEdit={() => setForm({ kind: "project", editing: d })}
                    onRemove={() => run(actions.remove?.(projectId, d.project.id))}
                  />
                ))}
              </ul>
            )}
            {canEdit &&
              (form?.kind === "project" ? (
                <DependencyForm
                  projectId={projectId}
                  view={view}
                  editing={form.editing}
                  busy={busy}
                  onCancel={() => setForm(null)}
                  onSubmit={async (blockedById, input) => {
                    const r = await run(form.editing ? actions.update?.(projectId, blockedById, input) : actions.add?.(projectId, blockedById, input), true);
                    if (!r) setForm(null);
                    return r;
                  }}
                />
              ) : (
                <button type="button" className={GHOST} disabled={busy} onClick={() => setForm({ kind: "project" })} data-testid="add-blocker-project">
                  + {DependencyCopy.ADD_PROJECT}
                </button>
              ))}
            <div className={`${SUB} mt-1.5`}>{DependencyCopy.BLOCKING}</div>
            {view.blocking.length === 0 ? (
              <p className="text-muted type-table" data-testid="blocking-none">
                {DependencyCopy.NONE_BLOCKING}
              </p>
            ) : (
              <ul className="flex flex-col" data-testid="blocking-list">
                {view.blocking.map((d) => (
                  <DependencyRow
                    key={d.project.id}
                    row={d}
                    blocking
                    canEdit={canEdit}
                    busy={busy}
                    onOpen={onOpenProject ? () => onOpenProject(d.project.id) : undefined}
                    onRemove={() => run(actions.remove?.(d.project.id, projectId, projectId))}
                  />
                ))}
              </ul>
            )}
          </div>

          <div className="flex flex-col gap-1.5" data-testid="deps-external">
            <div className={SUB}>{DependencyCopy.EXTERNAL}</div>
            {view.blockers.length === 0 && form?.kind !== "external" && (
              <p className="text-muted type-table" data-testid="external-none">
                {DependencyCopy.NONE_EXTERNAL}
              </p>
            )}
            {view.blockers.length > 0 && (
              <ul className="flex flex-col" data-testid="external-list">
                {view.blockers.map((b) => (
                  <BlockerRow key={b.id} blocker={b} today={view.today} canEdit={canEdit} busy={busy} onEdit={() => setForm({ kind: "external", editing: b })} onResolve={() => setResolving(b)} />
                ))}
              </ul>
            )}
            {canEdit &&
              (form?.kind === "external" ? (
                <BlockerForm
                  projectId={projectId}
                  view={view}
                  editing={form.editing}
                  busy={busy}
                  onCancel={() => setForm(null)}
                  onSubmit={async (input) => {
                    const r = await run(form.editing ? actions.updateBlocker?.(projectId, form.editing.id, input) : actions.addBlocker?.(projectId, input), true);
                    if (!r) setForm(null);
                    return r;
                  }}
                />
              ) : (
                <button type="button" className={GHOST} disabled={busy} onClick={() => setForm({ kind: "external" })} data-testid="add-external-blocker">
                  + {DependencyCopy.ADD_EXTERNAL}
                </button>
              ))}
            {view.resolved.length > 0 && (
              <div className="mt-1 flex flex-col">
                <button
                  type="button"
                  aria-expanded={showResolved}
                  onClick={() => setShowResolved((v) => !v)}
                  className="inline-flex h-7 w-fit items-center gap-1 text-muted type-table hover:text-fg"
                  data-testid="resolved-toggle"
                >
                  <span className={showResolved ? "" : "-rotate-90"}>
                    <Chevron />
                  </span>
                  {DependencyCopy.resolvedCount(view.resolved.length)}
                </button>
                {showResolved && (
                  <ul className="flex flex-col" data-testid="resolved-list">
                    {view.resolved.map((b) => (
                      <ResolvedRow key={b.id} blocker={b} today={view.today} />
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </>
      )}
      {resolving && (
        <ResolveDialog
          blocker={resolving}
          busy={busy}
          onCancel={() => setResolving(null)}
          onResolve={async (text) => {
            const r = await run(actions.resolveBlocker?.(projectId, resolving.id, text), true);
            if (!r || r.kind === "save" || r.kind === "access") setResolving(null);
            return r && r.kind === "input" ? r.error : null;
          }}
        />
      )}
    </section>
  );
}

function StatusDot({ status }: { status: ProjectStatus }) {
  return <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: `var(${STATUS_VAR[status]})` }} />;
}

function PencilIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="M8.2 1.8 10.2 3.8 4.2 9.8 1.8 10.2 2.2 7.8z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

function CrossIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path d="M2 2l6 6M8 2 2 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function CheckIcon({ color }: { color?: string }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" style={color ? { color } : undefined}>
      <path d="M2.5 6.2 5 8.5 9.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Hover actions on the right; hidden at rest (and always reachable by keyboard focus). */
function HoverActions({ children }: { children: ReactNode }) {
  return <span className="ml-auto flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">{children}</span>;
}

/** 36px row (52px with a note or milestone line). `blocking`: Remove only, and the name opens that project. */
function DependencyRow({
  row,
  blocking = false,
  canEdit,
  busy,
  onEdit,
  onRemove,
  onOpen,
}: {
  row: DependencyRowDto;
  blocking?: boolean;
  canEdit: boolean;
  busy: boolean;
  onEdit?: () => void;
  onRemove: () => void;
  onOpen?: () => void;
}) {
  const two = Boolean(row.note || row.milestone);
  const name = onOpen ? (
    <button type="button" onClick={onOpen} title={row.project.name} className="min-w-0 truncate text-left text-fg hover:underline" data-testid="blocking-open">
      {row.project.name}
    </button>
  ) : (
    <span className="min-w-0 truncate text-fg" title={row.project.name}>
      {row.project.name}
    </span>
  );
  return (
    <li className={`group flex items-center gap-2 rounded-control px-1.5 hover:bg-white/[.03] ${two ? "h-[52px]" : "h-9"}`} data-testid={blocking ? "blocking-row" : "blocked-by-row"}>
      <StatusDot status={row.project.status} />
      <div className="flex min-w-0 flex-1 flex-col justify-center">
        <div className="flex min-w-0 items-center gap-2 type-table">
          {name}
          <span className="shrink-0 text-muted type-caption">{ProjectStatusInfo.label(row.project.status)}</span>
          {row.milestone && (
            <span className="min-w-0 shrink truncate rounded-[4px] border border-line px-1 text-[11px] leading-4 text-muted" title={row.milestone.name} data-testid="dep-milestone">
              ◇ {row.milestone.name}
            </span>
          )}
        </div>
        {row.note && (
          <div className="truncate text-muted type-caption" title={row.note} data-testid="dep-note">
            {row.note}
          </div>
        )}
      </div>
      {canEdit && (
        <HoverActions>
          {!blocking && onEdit && (
            <button type="button" className={ICON} disabled={busy} aria-label={DependencyCopy.edit(row.project.name)} title={DependencyCopy.EDIT} onClick={onEdit}>
              <PencilIcon />
            </button>
          )}
          <button type="button" className={ICON} disabled={busy} aria-label={DependencyCopy.remove(row.project.name)} title={DependencyCopy.REMOVE} onClick={onRemove} data-testid="dep-remove">
            <CrossIcon />
          </button>
        </HoverActions>
      )}
    </li>
  );
}

/** Open external blocker, 52px: amber dot, description, then waiting on, since, follow-up (amber when overdue), owner. */
function BlockerRow({ blocker, today, canEdit, busy, onEdit, onResolve }: { blocker: BlockerDto; today: string; canEdit: boolean; busy: boolean; onEdit: () => void; onResolve: () => void }) {
  const overdue = BlockerRules.isFollowUpOverdue(blocker.followUpOn, today);
  const line = [
    `${DependencyCopy.WAITING_ON} ${blocker.waitingOn}`,
    DependencyCopy.since(blocker.since, today),
    blocker.followUpOn ? DependencyCopy.followUp(blocker.followUpOn, today, overdue) : null,
    blocker.followUpOwner,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <li className="group flex h-[52px] items-center gap-2 rounded-control px-1.5 hover:bg-white/[.03]" data-testid="external-row" data-overdue={overdue || undefined}>
      <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ background: AMBER }} />
      <div className="flex min-w-0 flex-1 flex-col justify-center">
        <div className="truncate text-[13px] leading-5 font-medium text-fg" title={blocker.description}>
          {blocker.description}
        </div>
        {/* The follow-up never truncates (an overdue date must stay visible); "Waiting on" and the owner give way first. */}
        <div className="flex min-w-0 items-baseline text-muted type-caption" title={line}>
          <span className="min-w-0 truncate">
            {DependencyCopy.WAITING_ON} {blocker.waitingOn} · {DependencyCopy.since(blocker.since, today)}
          </span>
          {blocker.followUpOn && (
            <span className="shrink-0 whitespace-pre" style={overdue ? { color: AMBER } : undefined} data-testid={overdue ? "follow-up-overdue" : "follow-up"}>
              {" · "}
              {DependencyCopy.followUp(blocker.followUpOn, today, overdue)}
            </span>
          )}
          {blocker.followUpOwner && <span className="min-w-[3ch] truncate whitespace-pre">{` · ${blocker.followUpOwner}`}</span>}
        </div>
      </div>
      {canEdit && (
        <HoverActions>
          <button type="button" className={ICON} disabled={busy} aria-label={DependencyCopy.edit(blocker.description)} title={DependencyCopy.EDIT} onClick={onEdit}>
            <PencilIcon />
          </button>
          <button type="button" className={ICON} disabled={busy} aria-label={DependencyCopy.resolve(blocker.description)} title={DependencyCopy.RESOLVE} onClick={onResolve} data-testid="external-resolve">
            <CheckIcon />
          </button>
        </HoverActions>
      )}
    </li>
  );
}

function ResolvedRow({ blocker, today }: { blocker: BlockerDto; today: string }) {
  return (
    <li className="flex h-[52px] items-center gap-2 px-1.5 opacity-70" data-testid="resolved-row">
      <CheckIcon color="var(--status-complete-dark-fg)" />
      <div className="flex min-w-0 flex-1 flex-col justify-center">
        <div className="truncate text-muted type-table" title={blocker.description}>
          {blocker.description}
        </div>
        <div className="truncate text-muted type-caption" title={blocker.resolution ?? undefined}>
          {blocker.resolvedOn ? DependencyCopy.resolvedBy(blocker.resolvedOn, today, blocker.resolvedBy) : ""}
          {blocker.resolution ? ` · "${blocker.resolution}"` : ""}
        </div>
      </div>
    </li>
  );
}

/** "84/120" under a field: amber from the warn length, red at the max (typing stops there). */
function Counter({ length, max, warn, id }: { length: number; max: number; warn?: number; id?: string }) {
  const tone = BlockerRules.counterTone(length, max, warn ?? max - 10);
  return (
    <span id={id} className="shrink-0 tabular-nums type-caption" style={{ color: tone === "max" ? "var(--status-off-track-dark-fg)" : tone === "warn" ? AMBER : undefined }} data-testid="char-counter" data-tone={tone}>
      {DependencyCopy.counter(length, max)}
    </span>
  );
}

function milestoneOptions(view: DependencyView, keep?: { id: string; name: string } | null) {
  const list = [...view.milestones];
  if (keep && !list.some((m) => m.id === keep.id)) list.push(keep);
  return [{ value: "", label: DependencyCopy.NO_MILESTONE }, ...list.map((m) => ({ value: m.id, label: m.name }))];
}

function FormButtons({ busy, submitLabel, onCancel, disabled }: { busy: boolean; submitLabel: string; onCancel: () => void; disabled?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <button type="submit" disabled={busy || disabled} className="h-7 rounded-control bg-accent px-3 text-white type-table-strong disabled:opacity-60" data-testid="deps-form-submit">
        {submitLabel}
      </button>
      <button type="button" onClick={onCancel} className="h-7 rounded-control px-2 text-muted type-table-strong hover:text-fg">
        {DependencyCopy.CANCEL}
      </button>
    </div>
  );
}

/** Inline "Add blocker project" (or edit an existing one: the project is fixed, note and milestone change). */
function DependencyForm({
  projectId,
  view,
  editing,
  busy,
  onCancel,
  onSubmit,
}: {
  projectId: string;
  view: DependencyView;
  editing?: DependencyRowDto;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (blockedById: string, input: DependencyInput) => Promise<{ error: string; kind?: string } | null>;
}) {
  const [picked, setPicked] = useState<DependencyProjectDto | null>(editing ? { id: editing.project.id, name: editing.project.name } : null);
  const [note, setNote] = useState(editing?.note ?? "");
  const [milestone, setMilestone] = useState(editing?.milestone?.id ?? "");
  const [error, setError] = useState<{ error: string; kind?: string } | null>(null);
  const errorId = `dep-${projectId}-error`;
  const ruleError = error?.kind === "rule";
  return (
    <form
      className="flex flex-col gap-2 rounded-control border border-line bg-white/[.02] p-2.5"
      data-testid="dependency-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!picked) return;
        setError(await onSubmit(picked.id, { note, blockedMilestoneId: milestone || null }));
      }}
    >
      {editing ? (
        <div className="truncate text-fg type-table-strong" title={editing.project.name}>
          {editing.project.name}
        </div>
      ) : (
        <ProjectPicker
          id={`dep-${projectId}`}
          options={view.options}
          value={picked}
          disabled={busy}
          invalid={ruleError}
          errorId={errorId}
          onType={() => ruleError && setError(null)}
          onPick={(p) => {
            setPicked(p);
            if (ruleError) setError(null);
          }}
        />
      )}
      <label className="flex flex-col gap-1">
        <span className={SUB}>{DependencyCopy.WAITING_ON}</span>
        <input
          className={INPUT}
          value={note}
          maxLength={BlockerRules.NOTE_MAX}
          placeholder={DependencyCopy.WAITING_ON_HINT}
          onChange={(e) => setNote(e.target.value.slice(0, BlockerRules.NOTE_MAX))}
          aria-describedby={`dep-${projectId}-note-count`}
          data-testid="dependency-note"
        />
        <span className="flex justify-end">
          <Counter id={`dep-${projectId}-note-count`} length={note.length} max={BlockerRules.NOTE_MAX} warn={BlockerRules.NOTE_WARN} />
        </span>
      </label>
      <div className="flex flex-col gap-1">
        <span className={SUB}>{DependencyCopy.BLOCKED_MILESTONE}</span>
        <PickerSelect id={`dep-${projectId}-milestone`} label={DependencyCopy.BLOCKED_MILESTONE} value={milestone} options={milestoneOptions(view, editing?.milestone)} onChange={setMilestone} testId="dependency-milestone" />
      </div>
      {error && (
        <div id={errorId}>
          <AiAlert tone="danger" testId="dependencies-error">
            {error.error}
          </AiAlert>
        </div>
      )}
      <FormButtons busy={busy} submitLabel={editing ? DependencyCopy.SAVE : DependencyCopy.ADD} onCancel={onCancel} disabled={!picked} />
    </form>
  );
}

/** Inline "Add external blocker" (or edit one). "Since" is set on save and never edited. */
function BlockerForm({
  projectId,
  view,
  editing,
  busy,
  onCancel,
  onSubmit,
}: {
  projectId: string;
  view: DependencyView;
  editing?: BlockerDto;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (input: BlockerInput) => Promise<{ error: string; kind?: string } | null>;
}) {
  const [description, setDescription] = useState(editing?.description ?? "");
  const [waitingOn, setWaitingOn] = useState(editing?.waitingOn ?? "");
  const [followUpOn, setFollowUpOn] = useState(editing?.followUpOn ?? "");
  const [pickingDate, setPickingDate] = useState(false);
  const [owner, setOwner] = useState(editing?.followUpOwner ?? "");
  const [milestone, setMilestone] = useState(editing?.milestone?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const people = owner && !view.people.includes(owner) ? [owner, ...view.people] : view.people;
  return (
    <form
      className="flex flex-col gap-2 rounded-control border border-line bg-white/[.02] p-2.5"
      data-testid="external-form"
      onSubmit={async (e) => {
        e.preventDefault();
        const r = await onSubmit({ description, waitingOn, followUpOn: followUpOn || null, followUpOwner: owner || null, blockedMilestoneId: milestone || null });
        setError(r ? r.error : null);
      }}
    >
      <label className="flex flex-col gap-1">
        <span className={SUB}>{DependencyCopy.DESCRIPTION}</span>
        <input className={INPUT} required value={description} maxLength={BlockerRules.DESCRIPTION_MAX} onChange={(e) => setDescription(e.target.value)} data-testid="external-description" />
      </label>
      <label className="flex flex-col gap-1">
        <span className={SUB}>{DependencyCopy.WAITING_ON}</span>
        <input
          className={INPUT}
          required
          value={waitingOn}
          maxLength={BlockerRules.WAITING_ON_MAX}
          placeholder={DependencyCopy.EXTERNAL_WAITING_PLACEHOLDER}
          onChange={(e) => setWaitingOn(e.target.value)}
          data-testid="external-waiting-on"
        />
      </label>
      <div className="grid grid-cols-2 gap-2">
        <div className="flex flex-col gap-1">
          <span className={SUB}>{DependencyCopy.FOLLOW_UP}</span>
          {pickingDate ? (
            <DueDatePopover saved={followUpOn} today={view.today} label={DependencyCopy.FOLLOW_UP} onSave={setFollowUpOn} onClose={() => setPickingDate(false)} fieldClassName={`${INPUT} tabular-nums`} />
          ) : (
            <button type="button" className={`${INPUT} text-left tabular-nums ${followUpOn ? "" : "text-muted"}`} onClick={() => setPickingDate(true)} data-testid="external-follow-up">
              {followUpOn || "YYYY-MM-DD"}
            </button>
          )}
        </div>
        <div className="flex flex-col gap-1">
          <span className={SUB}>{DependencyCopy.FOLLOW_UP_OWNER}</span>
          <PickerSelect
            id={`blk-${projectId}-owner`}
            label={DependencyCopy.FOLLOW_UP_OWNER}
            value={owner}
            options={[{ value: "", label: DependencyCopy.NO_OWNER }, ...people.map((p) => ({ value: p, label: p }))]}
            onChange={setOwner}
            testId="external-owner"
          />
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <span className={SUB}>{DependencyCopy.BLOCKED_MILESTONE}</span>
        <PickerSelect id={`blk-${projectId}-milestone`} label={DependencyCopy.BLOCKED_MILESTONE} value={milestone} options={milestoneOptions(view, editing?.milestone)} onChange={setMilestone} testId="external-milestone" />
      </div>
      {editing && <div className="text-muted type-caption">{DependencyCopy.since(editing.since, view.today).replace(/^s/, "S")}</div>}
      {error && (
        <AiAlert tone="danger" testId="external-error">
          {error}
        </AiAlert>
      )}
      <FormButtons busy={busy} submitLabel={editing ? DependencyCopy.SAVE : DependencyCopy.ADD} onCancel={onCancel} disabled={!description.trim() || !waitingOn.trim()} />
    </form>
  );
}

/** "Resolve blocker": the #74 dialog style with a required "What resolved it?" (200 max). Escape keeps the drawer open. */
function ResolveDialog({ blocker, busy, onCancel, onResolve }: { blocker: BlockerDto; busy: boolean; onCancel: () => void; onResolve: (text: string) => Promise<string | null> }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  if (typeof document === "undefined") return null;
  return createPortal(
    <div data-resolve-dialog className="fixed inset-0 z-50 grid place-items-center bg-black/50" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <form
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="resolve-blocker-title"
        data-testid="resolve-dialog"
        className="flex w-[440px] flex-col gap-3 rounded-card border border-line bg-card px-5 py-4 shadow-[0_12px_32px_rgba(0,0,0,.45)]"
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.stopPropagation();
          onCancel();
        }}
        onSubmit={async (e) => {
          e.preventDefault();
          setError(await onResolve(text));
        }}
      >
        <h2 id="resolve-blocker-title" className="type-heading">
          {DependencyCopy.RESOLVE_TITLE}
        </h2>
        <p className="truncate text-muted type-table" title={blocker.description}>
          {blocker.description}
        </p>
        <label className="flex flex-col gap-1">
          <span className={SUB}>{DependencyCopy.RESOLVE_LABEL}</span>
          <textarea
            autoFocus
            required
            rows={3}
            value={text}
            maxLength={BlockerRules.RESOLUTION_MAX}
            onChange={(e) => setText(e.target.value)}
            className="w-full resize-none rounded-control border border-line bg-input px-2 py-1.5 text-fg type-table focus:border-accent focus:outline-none"
            data-testid="resolve-text"
          />
          <span className="flex justify-end">
            <Counter length={text.length} max={BlockerRules.RESOLUTION_MAX} />
          </span>
        </label>
        {error && (
          <AiAlert tone="danger" testId="resolve-error">
            {error}
          </AiAlert>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="h-7 rounded-control border border-line px-3 text-muted type-table-strong hover:text-fg">
            {DependencyCopy.CANCEL}
          </button>
          <button type="submit" disabled={busy || !text.trim()} className="h-7 rounded-control bg-accent px-3 text-white type-table-strong disabled:opacity-60" data-testid="resolve-submit">
            {DependencyCopy.RESOLVE}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}

/** Searchable single-pick list of projects (ARIA 1.2 combobox). Shows the picked project while closed. */
export function ProjectPicker({
  id,
  options,
  disabled,
  invalid,
  errorId,
  onType,
  onPick,
  value = null,
}: {
  id: string;
  options: readonly DependencyProjectDto[];
  /** The picked project, shown in the field while the list is closed. */
  value?: DependencyProjectDto | null;
  disabled?: boolean;
  /** An add was rejected: red error border (drawer [data-invalid] style), aria-invalid and aria-describedby the error. */
  invalid?: boolean;
  errorId?: string;
  /** The input text changed (clears the add error). */
  onType?: () => void;
  onPick: (p: DependencyProjectDto) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(-1);
  const [place, setPlace] = useState<{ left: number; width: number; top?: number; bottom?: number; maxHeight: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = `${id}-listbox`;
  const q = query.trim().toLowerCase();
  const rows = q ? options.filter((o) => o.name.toLowerCase().includes(q)) : options;
  const active = open && highlight >= 0 && highlight < rows.length ? rows[highlight] : null;

  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const el = inputRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const { up, maxHeight } = PeopleComboboxModel.placement(rect, window.innerHeight);
      setPlace({ left: rect.left, width: Math.max(rect.width, 240), maxHeight, ...(up ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }) });
    };
    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [open]);

  const close = () => {
    setOpen(false);
    setQuery("");
    setHighlight(-1);
  };
  const pick = (p: DependencyProjectDto) => {
    close();
    onPick(p);
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        setHighlight(0);
        return;
      }
      setHighlight((h) => PeopleComboboxModel.move(h, e.key === "ArrowDown" ? 1 : -1, rows.length));
    } else if (e.key === "Enter") {
      if (!open) return;
      e.preventDefault();
      if (active) pick(active);
    } else if (e.key === "Escape") {
      if (!open) return;
      e.preventDefault();
      e.stopPropagation(); // keep the drawer open
      close();
    } else if (e.key === "Tab" && open) close();
  };

  return (
    <div className={FieldControlStyle.WRAP} data-invalid={invalid || undefined}>
      <input
        ref={inputRef}
        id={id}
        type="text"
        aria-invalid={invalid ? true : undefined}
        aria-describedby={invalid ? errorId : undefined}
        role="combobox"
        aria-label={DependencyCopy.ADD_PLACEHOLDER}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-autocomplete="list"
        aria-activedescendant={active ? `${id}-opt-${active.id}` : undefined}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        data-testid="dependency-picker"
        value={open ? query : (value?.name ?? "")}
        placeholder={open ? DependencyCopy.SEARCH_PLACEHOLDER : DependencyCopy.ADD_PLACEHOLDER}
        onChange={(e) => {
          setQuery(e.target.value);
          onType?.();
          setOpen(true);
          setHighlight(0);
        }}
        onClick={() => !open && setOpen(true)}
        onKeyDown={onKeyDown}
        onBlur={close}
        className={`${FieldControlStyle.BOX} h-8 text-fg placeholder:text-muted disabled:opacity-50`}
      />
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        onMouseDown={(e) => {
          e.preventDefault();
          inputRef.current?.focus();
          if (open) close();
          else setOpen(true);
        }}
        className={FieldControlStyle.CHEVRON_SLOT}
      >
        <Chevron open={open} />
      </button>
      {open &&
        place &&
        typeof document !== "undefined" &&
        createPortal(
          <ul
            id={listId}
            role="listbox"
            aria-label={DependencyCopy.BLOCKED_BY}
            style={{ position: "fixed", left: place.left, width: place.width, top: place.top, bottom: place.bottom, maxHeight: place.maxHeight }}
            className="z-[1000] overflow-y-auto rounded-card border border-line bg-card py-1 type-table shadow-md"
          >
            {rows.length === 0 ? (
              <li role="presentation" className="flex h-8 cursor-default items-center px-3 text-muted select-none">
                {options.length ? DependencyCopy.NO_MATCH : DependencyCopy.NO_OPTIONS}
              </li>
            ) : (
              rows.map((r, i) => (
                <li
                  key={r.id}
                  id={`${id}-opt-${r.id}`}
                  role="option"
                  aria-selected={active?.id === r.id}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => pick(r)}
                  className={`flex h-8 cursor-pointer items-center px-3 text-fg ${active?.id === r.id ? "bg-row-selected outline-2 -outline-offset-2 outline-accent outline-solid" : ""}`}
                >
                  <span className="min-w-0 flex-1 truncate">{r.name}</span>
                </li>
              ))
            )}
          </ul>,
          document.body,
        )}
    </div>
  );
}
