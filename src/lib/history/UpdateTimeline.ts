import { DisplayName } from "@/lib/auth/DisplayName";
import { DefaultMilestone } from "@/lib/projects/DefaultMilestone";
import { MilestoneRules } from "@/lib/domain/MilestoneRules";
import { CompletionCopy } from "@/lib/projects/CompletionCopy";
import { CompletionRules } from "@/lib/projects/CompletionRules";
import { ProjectStatusInfo } from "@/lib/domain/ProjectStatusInfo";
import type { ProjectStatus } from "@/generated/prisma/enums";
import { HistoryEntries } from "@/lib/history/HistoryEntries";
import { ClosedPagesCopy } from "@/lib/closed/ClosedPagesCopy";
import { RestoreRules } from "@/lib/closed/RestoreRules";
import { UpdateHistoryCopy as C } from "@/lib/history/UpdateHistoryCopy";
import { ReportFormat } from "@/lib/report/pdf/ReportFormat";
import { VisibilityPolicy } from "@/lib/visibility/VisibilityPolicy";

/** The ProjectHistory columns the timeline reads. */
export interface TimelineRow {
  field: string;
  oldValue: string | null;
  newValue: string | null;
  changedAt: Date;
  changedBy: string;
  comment: string | null;
}

/** An Infor number from before this tracker (project_prior_infor_number). recordedAt null = date unknown. */
export interface PriorInforRow {
  number: number;
  recordedAt: Date | null;
}

export interface TimelineLine {
  text: string;
  /** Long text ("Note updated."): the "Show change" link opens gray Before and After blocks. */
  change?: { before: string | null; after: string | null };
  /** Hide/delete events: a small gray "Admin" tag at the end of the meta line (admins only ever get these rows). */
  admin?: boolean;
}

/** One line shown: the gray meta line over one sentence. A save that changed three fields shows three entries. */
export interface TimelineEntry extends TimelineLine {
  key: string;
  /** null for "Before this tracker". */
  at: Date | null;
  /** "Sep 27, 2026, 1:20 AM ET · Nick Leary", or "Before this tracker". */
  meta: string;
  /** System (Tracker) and before-this-tracker entries get a hollow dot. */
  hollow: boolean;
}

/** One past "Latest update" note edit (Update notes, task 4): read-only, the full text as saved. */
export interface NoteEntry {
  key: string;
  at: Date;
  /** "Oct 4, 2026, 11:40 AM ET · Nick Leary" (same meta line as History). */
  meta: string;
  /** Who made the edit (the meta line's name). */
  who: string;
  /** The full note as entered (ProjectHistory.newValue), or null when the edit cleared the note. */
  text: string | null;
  /** A legacy entry that kept only a shortened copy of the note (UpdateTimeline.isShortened): muted "(shortened)" tag. */
  shortened: boolean;
  /** Saved from an accepted AI suggestion (comment UpdateTimeline.AI_ASSISTED_COMMENT): "AI-assisted" tag. Absent otherwise. */
  aiAssisted?: true;
}

/** A step for Project detail > Milestones (full name, owner). */
export interface TimelineStep {
  key: string;
  name: string;
  done: boolean;
  /** Owner name, or null (Unassigned). */
  owner: string | null;
}

export interface Timeline {
  /** Every line shown, newest first; undated earlier numbers always last. Note edits are not here (see notes). */
  entries: TimelineEntry[];
  /** Note edits, newest first (Update notes). */
  notes: NoteEntry[];
  /** The project's steps in order (filled by ProjectHistoryService.timeline; empty when built from rows alone). */
  steps: TimelineStep[];
  /** "History (N)": N counts lines shown. */
  title: string;
  /** Numbers the project had before its current one, newest first (for "Previously REQ-4656, REQ-4412"). */
  priorInforNumbers: number[];
  previously: string | null;
}

/** What the drawer receives (serializable: no Dates). */
export interface TimelineDto {
  title: string;
  entries: (TimelineLine & { key: string; meta: string; hollow: boolean })[];
  previously: string | null;
  notes: { key: string; meta: string; who: string; text: string | null; shortened: boolean; aiAssisted?: true }[];
  steps: TimelineStep[];
}

/**
 * Builds Project detail > History from ProjectHistory rows (one entry per save) and earlier Infor numbers. Pure: the
 * caller loads rows already filtered for the viewer (ProjectHistoryService), so admin-only events only arrive for admins.
 */
export class UpdateTimeline {
  /** Entries shown before "Show all N changes". */
  static readonly INITIAL_ENTRIES = 10;
  /** Update notes shown before "Show all N updates". */
  static readonly INITIAL_NOTES = 5;
  /**
   * History fields that list under Update notes instead of the change log (task 4). Filtered at read time: the stored
   * history rows are never rewritten or deleted.
   */
  static readonly NOTE_FIELDS: ReadonlySet<string> = new Set(["note"]);
  /** ProjectHistory.comment on People page renames (ProjectService.renamePerson). */
  static readonly PEOPLE_RENAME_COMMENT = "people_rename";
  /** ProjectHistory.comment on CSV-created projects (ImportService.SOURCE_CREATE). */
  static readonly CSV_IMPORT_COMMENT = "csv_import";
  /** DepartmentCopy.deletedToast: "Cath deleted. 3 projects moved to CVSS." on each moved project's row. */
  private static readonly DEPARTMENT_DELETED = /^.+ deleted\. \d+ projects? moved to .+\.$/;

  /** On-screen labels (Project detail). */
  static readonly LABELS: Readonly<Record<string, string>> = {
    name: "Project name",
    description: "Description",
    inforRequestNumber: "Infor number",
    serviceArea: "Department",
    owner: "Owner",
    physicianChampion: "Requester",
    physicianChampionEmail: "Requester email",
    contractsLead: "Contracts lead",
    status: "Status",
    nextMilestone: "Next milestone",
    dueDate: "Due date",
    targetCompletion: "Target completion",
    percentComplete: "Percent complete",
    note: "Note",
    accomplishment: "Accomplishment",
    completedOn: "Completion date",
  };

  /** Long text: one "X updated." line with Before and After instead of inline values. */
  private static readonly LONG_TEXT: ReadonlySet<string> = new Set(["description", "note", "accomplishment"]);
  private static readonly DATES: ReadonlySet<string> = new Set(["dueDate", "targetCompletion", "completedOn"]);
  /** Mirrors of the next open step, covered by the step lines in the same save. */
  private static readonly STEP_MIRRORS: ReadonlySet<string> = new Set(["nextMilestone", "dueDate"]);
  /**
   * Not shown: deletedBy is written alongside another row that already says it; start date changes are listed only
   * on the admin audit page (Admin > Audit), never in Project detail > History.
   */
  private static readonly SILENT: ReadonlySet<string> = new Set(["deletedBy", "startDate"]);
  private static readonly MILESTONE_COMPLETED = "milestone_completed";

  /** Reading order inside one save. */
  private static readonly ORDER: readonly string[] = [
    "created",
    "archivedAt",
    "hiddenFromDashboard",
    "hiddenFromReport",
    "name",
    "status",
    "completion",
    "milestone_template_applied",
    "milestone_completed",
    "milestone_added",
    "milestone_renamed",
    "milestone_done",
    "milestone_reopened",
    "milestone_due",
    "milestone_owner",
    "milestone_deleted",
    "milestone_auto_added",
    "milestones_reordered",
    "serviceArea",
    "owner",
    "physicianChampion",
    "requesterNotApplicable",
    "physicianChampionEmail",
    "contractsLead",
    "inforRequestNumber",
    "nextMilestone",
    "dueDate",
    "targetCompletion",
    "percentComplete",
    "completedOn",
    "includeInReport",
    "description",
    "note",
    "accomplishment",
  ];

  /**
   * `people` are the line's People list names (owners, requesters, contracts leads): the meta line prefers their spelling
   * when exactly one of them matches the email.
   */
  /** The old note cap (AppConfig.NOTE_MAX_LENGTH before task 2). */
  static readonly LEGACY_NOTE_MAX = 200;

  /**
   * Detection rule for a legacy shortened copy: the stored text ends in "…" (U+2026) and is the old 200-character cap
   * long (200 or 201 characters with the ellipsis). The app has always stored the full note (HistoryDiff.serialize), so
   * this only flags copies cut to the old cap elsewhere (none in production on Oct 4, 2026).
   */
  static isShortened(text: string | null | undefined): boolean {
    if (!text || !text.endsWith("\u2026")) return false;
    return text.length === UpdateTimeline.LEGACY_NOTE_MAX || text.length === UpdateTimeline.LEGACY_NOTE_MAX + 1;
  }

  static build(rows: readonly TimelineRow[], prior: readonly PriorInforRow[], currentInfor: number | null, people: readonly string[] = []): Timeline {
    const dated: TimelineEntry[] = [];
    const notes: NoteEntry[] = [];
    for (const g of HistoryEntries.group(rows)) {
      const who = UpdateTimeline.actor(g.changedBy, people);
      const meta = C.meta(ReportFormat.dateTimeEt(g.changedAt), who);
      g.rows
        .filter((r) => UpdateTimeline.NOTE_FIELDS.has(r.field))
        .forEach((r, i) =>
          notes.push({
            key: `note|${g.changedAt.getTime()}|${g.changedBy}|${i}`,
            at: g.changedAt,
            meta,
            who,
            text: r.newValue ? r.newValue : null,
            shortened: UpdateTimeline.isShortened(r.newValue),
            ...(r.comment === UpdateTimeline.AI_ASSISTED_COMMENT ? { aiAssisted: true as const } : {}),
          }),
        );
      UpdateTimeline.lines(g.rows.filter((r) => !UpdateTimeline.NOTE_FIELDS.has(r.field))).forEach((line, i) => {
        dated.push({ ...line, key: `${g.changedAt.getTime()}|${g.changedBy}|${i}`, at: g.changedAt, meta, hollow: who === C.TRACKER });
      });
    }
    for (const p of prior) {
      if (p.recordedAt) dated.push({ key: `prior|${p.number}`, at: p.recordedAt, meta: C.meta(ReportFormat.dateTimeEt(p.recordedAt), C.TRACKER), hollow: true, text: C.earlierInfor(p.number) });
    }
    // Stable sort: lines of one save keep their reading order.
    dated.sort((a, b) => b.at!.getTime() - a.at!.getTime());
    // Numbers from before this tracker have no date and always come last, below every dated entry.
    const undated: TimelineEntry[] = prior
      .filter((p) => !p.recordedAt)
      .sort((a, b) => b.number - a.number)
      .map((p) => ({ key: `prior|${p.number}`, at: null, meta: C.BEFORE_THIS_TRACKER, hollow: true, text: C.earlierInfor(p.number) }));
    const entries = [...dated, ...undated];
    const priorInforNumbers = UpdateTimeline.priorInforNumbers(rows, prior, currentInfor);
    notes.sort((a, b) => b.at.getTime() - a.at.getTime());
    return { entries, notes, steps: [], title: C.title(entries.length), priorInforNumbers, previously: C.previously(priorInforNumbers) };
  }

  static toDto(t: Timeline): TimelineDto {
    return {
      title: t.title,
      entries: t.entries.map(({ key, meta, hollow, text, change, admin }) => ({ key, meta, hollow, text, ...(change ? { change } : {}), ...(admin ? { admin } : {}) })),
      previously: t.previously,
      notes: t.notes.map(({ key, meta, who, text, shortened, aiAssisted }) => ({ key, meta, who, text, shortened, ...(aiAssisted ? { aiAssisted } : {}) })),
      steps: t.steps,
    };
  }

  /** Earlier numbers, newest first: replaced numbers from history, then recorded ones, never the current one. */
  static priorInforNumbers(rows: readonly TimelineRow[], prior: readonly PriorInforRow[], currentInfor: number | null): number[] {
    const fromHistory = rows
      .filter((r) => r.field === "inforRequestNumber" && r.oldValue !== null)
      .sort((a, b) => b.changedAt.getTime() - a.changedAt.getTime())
      .map((r) => Number(r.oldValue));
    const recorded = [...prior].sort((a, b) => (b.recordedAt?.getTime() ?? -Infinity) - (a.recordedAt?.getTime() ?? -Infinity)).map((p) => p.number);
    const out: number[] = [];
    for (const n of [...fromHistory, ...recorded]) {
      if (Number.isInteger(n) && n !== currentInfor && !out.includes(n)) out.push(n);
    }
    return out;
  }

  /**
   * Who made the change: "Tracker" for system writes; else a People list name when exactly one matches the email
   * ("nick.leary@" or "nleary@" -> "Nick Leary"); else the name read from the email; else the email as saved.
   */
  static actor(changedBy: string, people: readonly string[] = []): string {
    const by = changedBy.trim();
    if (!by || /^(system|cron|migration)\b/i.test(by)) return C.TRACKER;
    if (!by.includes("@")) return by;
    const local = by.split("@")[0].toLowerCase();
    const letters = (v: string) => v.toLowerCase().replace(/[^a-z]/g, "");
    const key = letters(local);
    const hits = new Set<string>();
    for (const name of people) {
      const words = name.replace(/^dr\.?\s+/i, "").split(/\s+/).map(letters).filter(Boolean);
      if (words.length < 2) continue;
      const full = words.join("");
      const initialLast = words[0][0] + words[words.length - 1];
      if (key && (key === full || key === initialLast)) hits.add(name);
    }
    if (hits.size === 1) return [...hits][0];
    return /[._-]/.test(local) ? DisplayName.fromEmail(by) : by;
  }

  /** The lines for one save, in reading order. */
  static lines(rows: readonly TimelineRow[]): TimelineLine[] {
    const byField = new Map(rows.map((r) => [r.field, r]));
    const hasSteps = rows.some((r) => r.field.startsWith("milestone"));
    const rank = (f: string) => {
      const i = UpdateTimeline.ORDER.indexOf(f);
      return i < 0 ? UpdateTimeline.ORDER.length : i;
    };
    const out: TimelineLine[] = [];
    // Completion rules (task 5): the "completion" row says it all; its status row and the form's completedOn row are
    // the same change in other words.
    const completion = rows.some((r) => r.field === CompletionRules.HISTORY_FIELD);
    for (const row of [...rows].sort((a, b) => rank(a.field) - rank(b.field))) {
      if (UpdateTimeline.SILENT.has(row.field)) continue;
      if (completion && (row.field === "completedOn" || (row.field === "status" && row.comment?.startsWith(UpdateTimeline.COMPLETION_PREFIX)))) continue;
      if (hasSteps && UpdateTimeline.STEP_MIRRORS.has(row.field)) continue;
      // Requester and its Not applicable flag read as one Requester sentence.
      if (row.field === "requesterNotApplicable" && byField.has("physicianChampion")) continue;
      const na = byField.get("requesterNotApplicable");
      const line =
        (row.field === "physicianChampion" || row.field === "requesterNotApplicable") && na && row.comment !== UpdateTimeline.PEOPLE_RENAME_COMMENT
          ? UpdateTimeline.requesterLine(byField.get("physicianChampion") ?? null, na)
          : UpdateTimeline.line(row);
      if (line) out.push(VisibilityPolicy.ADMIN_ONLY_HISTORY_FIELDS.includes(row.field) ? { ...line, admin: true } : line);
    }
    return out;
  }

  /** "Requester changed from To assign to Not applicable." / "Requester changed from Not applicable to Jane Doe." */
  private static requesterLine(name: TimelineRow | null, na: TimelineRow): TimelineLine | null {
    const state = (n: string | null | undefined, flag: string | null) => (n ? n : flag === "true" ? C.NOT_APPLICABLE : C.TO_ASSIGN);
    const before = state(name?.oldValue, na.oldValue);
    const after = state(name?.newValue, na.newValue);
    return before === after ? null : { text: C.changed(UpdateTimeline.label("physicianChampion"), before, after) };
  }

  static line(row: TimelineRow): TimelineLine | null {
    const { field, oldValue: before, newValue: after } = row;
    const label = UpdateTimeline.label(field);
    const F = MilestoneRules.FIELDS;
    switch (field) {
      case CompletionRules.HISTORY_FIELD: {
        const text = UpdateTimeline.completionText(row);
        return text ? { text } : null;
      }
      case DefaultMilestone.HISTORY_FIELD: {
        const text = DefaultMilestone.historyText(after);
        return text ? { text } : null;
      }
      case "created":
        return { text: row.comment === UpdateTimeline.CSV_IMPORT_COMMENT ? C.IMPORTED : C.PROJECT_CREATED };
      case F.added:
        return { text: C.addedStep(UpdateTimeline.stepName(after)) };
      case F.deleted:
        return { text: C.removedStep(UpdateTimeline.stepName(before)) };
      case F.renamed:
        return { text: C.renamedStep(before ?? "", after ?? "") };
      case F.done:
        return { text: C.checked(after ?? "") };
      case F.reopened:
        return { text: C.unchecked(before ?? "") };
      case UpdateTimeline.MILESTONE_COMPLETED:
        return before ? { text: C.checked(UpdateTimeline.stepName(before)) } : null;
      case F.due: {
        const b = UpdateTimeline.dueParts(before);
        const a = UpdateTimeline.dueParts(after);
        return { text: C.stepDue(a?.name ?? b?.name ?? "", b ? ReportFormat.mediumDate(b.due) : null, a ? ReportFormat.mediumDate(a.due) : null) };
      }
      case F.owner: {
        const b = UpdateTimeline.ownerParts(before);
        const a = UpdateTimeline.ownerParts(after);
        const step = a?.name ?? b?.name ?? "";
        if (row.comment === UpdateTimeline.PEOPLE_RENAME_COMMENT && b && a) return { text: C.stepOwnerRenamed(step, b.owner, a.owner) };
        return { text: C.stepOwner(step, b?.owner ?? null, a?.owner ?? null) };
      }
      case F.reordered:
        return { text: C.REORDERED };
      case F.templateApplied:
        return after ? { text: C.templateApplied(after) } : null;
      case "archivedAt":
        return { text: after ? C.DELETED : C.RESTORED };
      case "hiddenFromDashboard":
        return { text: after === "true" ? C.HIDDEN_DASHBOARD : C.SHOWN_DASHBOARD };
      case "hiddenFromReport":
        return { text: after === "true" ? C.HIDDEN_REPORT : C.SHOWN_REPORT };
      case "includeInReport":
        return before === after ? null : { text: C.inReportByCsv(after !== "false") };
    }
    if (field === "status" && RestoreRules.isRestoreComment(row.comment) && after) {
      const status = UpdateTimeline.value("status", after) ?? after;
      return { text: ClosedPagesCopy.restoreHistory(status, row.comment === RestoreRules.COMMENT) };
    }
    if (field === "serviceArea" && row.comment && UpdateTimeline.DEPARTMENT_DELETED.test(row.comment) && before && after) {
      return { text: C.movedOnDelete(before, after) };
    }
    if (row.comment === UpdateTimeline.PEOPLE_RENAME_COMMENT && before && after) {
      return { text: C.renamedOnPeoplePage(label, before, after) };
    }
    if (field === "nextMilestone") return before || after ? { text: C.nextMilestone(before || null, after || null) } : null;
    if (UpdateTimeline.LONG_TEXT.has(field)) return { text: C.updated(label), change: { before, after } };
    const b = UpdateTimeline.value(field, before);
    const a = UpdateTimeline.value(field, after);
    if (b !== null && a !== null) return { text: C.changed(label, b, a) };
    if (a !== null) return { text: C.set(label, a) };
    if (b !== null) return { text: C.cleared(label, b) };
    return null;
  }

  /** ProjectHistory.comment on a note row saved from an accepted AI suggestion (ProjectService.AI_ASSISTED_COMMENT). */
  static readonly AI_ASSISTED_COMMENT = "ai:assisted";

  /** ProjectHistory.comment prefix on completion rule rows (ProjectService.COMPLETION_COMMENT_PREFIX). */
  static readonly COMPLETION_PREFIX = "completion:";

  /** A "completion" row in CompletionCopy wording (the comment holds the event code). */
  static completionText(row: Pick<TimelineRow, "comment" | "oldValue" | "newValue">): string | null {
    const code = row.comment?.startsWith(UpdateTimeline.COMPLETION_PREFIX) ? row.comment.slice(UpdateTimeline.COMPLETION_PREFIX.length) : null;
    const n = row.newValue;
    const o = row.oldValue;
    switch (code) {
      case "auto":
        return n ? CompletionCopy.autoSet(n) : null;
      case "auto_again":
        return n ? CompletionCopy.completedAgain(n) : null;
      case "manual":
        return n ? CompletionCopy.manualSet(n) : null;
      case "reopened_added":
        return o ? CompletionCopy.reopenedAdded(o) : null;
      case "reopened_unchecked":
        return o ? CompletionCopy.reopenedUnchecked(o) : null;
      case "restored":
        return n ? CompletionCopy.restored(n) : null;
      case "manual_removed":
        return n ? CompletionCopy.manualRemoved(n) : null;
      case "manual_removed_no_auto":
        return o ? CompletionCopy.manualRemovedNoAuto(o) : null;
      default:
        return null;
    }
  }

  static label(field: string): string {
    return UpdateTimeline.LABELS[field] ?? MilestoneRules.FIELD_LABELS[field] ?? field;
  }

  /** A stored value as shown: status labels, REQ numbers, dates and percents formatted; text exactly as saved. */
  static value(field: string, stored: string | null): string | null {
    if (stored === null || stored === "") return null;
    if (field === "status") return ProjectStatusInfo.label(stored as ProjectStatus) ?? stored;
    if (field === "inforRequestNumber") return /^\d+$/.test(stored) ? C.infor(Number(stored)) : stored;
    if (UpdateTimeline.DATES.has(field) && /^\d{4}-\d{2}-\d{2}$/.test(stored)) return ReportFormat.mediumDate(stored);
    if (field === "percentComplete" && /^\d+$/.test(stored)) return `${stored}%`;
    return stored;
  }

  /** "Go-live (due 2026-10-01)" -> "Go-live" (MilestoneRules.describe). */
  private static stepName(described: string | null): string {
    return (described ?? "").replace(/ \(due \d{4}-\d{2}-\d{2}\)$/, "");
  }

  /** "Go-live: Kim Nguyen" (MilestoneRules.ownerLabel) -> parts. */
  private static ownerParts(label: string | null): { name: string; owner: string } | null {
    const m = label ? /^(.*): (.+)$/.exec(label) : null;
    return m ? { name: m[1], owner: m[2] } : null;
  }

  /** "Go-live: 2026-10-01" (MilestoneRules.dueLabel) -> parts. */
  private static dueParts(label: string | null): { name: string; due: string } | null {
    const m = label ? /^(.*): (\d{4}-\d{2}-\d{2})$/.exec(label) : null;
    return m ? { name: m[1], due: m[2] } : null;
  }
}
