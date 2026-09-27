import { DisplayName } from "@/lib/auth/DisplayName";
import { MilestoneRules } from "@/lib/domain/MilestoneRules";
import { ProjectStatusInfo } from "@/lib/domain/ProjectStatusInfo";
import type { ProjectStatus } from "@/generated/prisma/enums";
import { HistoryEntries } from "@/lib/history/HistoryEntries";
import { UpdateHistoryCopy as C } from "@/lib/history/UpdateHistoryCopy";
import { ReportFormat } from "@/lib/report/pdf/ReportFormat";

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
  /** Long text ("Note updated."): the "Show change" toggle opens gray Before and After blocks. */
  change?: { before: string | null; after: string | null };
}

export interface TimelineEntry {
  key: string;
  /** null for "Before this tracker". */
  at: Date | null;
  /** "Sep 27, 2026, 1:20 AM ET · Nick Leary", or "Before this tracker". */
  meta: string;
  lines: TimelineLine[];
}

export interface Timeline {
  /** Every entry, newest first; undated earlier numbers last. */
  entries: TimelineEntry[];
  /** "History (N)". */
  title: string;
  /** Numbers the project had before its current one, newest first (for "Previously REQ-4656, REQ-4412"). */
  priorInforNumbers: number[];
  previously: string | null;
}

/**
 * Builds Project detail > History from ProjectHistory rows (one entry per save) and earlier Infor numbers. Pure: the
 * caller loads rows already filtered for the viewer (ProjectHistoryService), so admin-only events only arrive for admins.
 */
export class UpdateTimeline {
  /** Entries shown before "Show all N changes". */
  static readonly INITIAL_ENTRIES = 10;
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
    completedOn: "Completed on",
  };

  /** Long text: one "X updated." line with Before and After instead of inline values. */
  private static readonly LONG_TEXT: ReadonlySet<string> = new Set(["description", "note", "accomplishment"]);
  private static readonly DATES: ReadonlySet<string> = new Set(["dueDate", "targetCompletion", "completedOn"]);
  /** Mirrors of the next open step, covered by the step lines in the same save. */
  private static readonly STEP_MIRRORS: ReadonlySet<string> = new Set(["nextMilestone", "dueDate"]);
  /** Written alongside another row that already says it. */
  private static readonly SILENT: ReadonlySet<string> = new Set(["deletedBy"]);
  private static readonly MILESTONE_COMPLETED = "milestone_completed";

  /** Reading order inside one save. */
  private static readonly ORDER: readonly string[] = [
    "created",
    "archivedAt",
    "hiddenFromDashboard",
    "hiddenFromReport",
    "name",
    "status",
    "milestone_template_applied",
    "milestone_completed",
    "milestone_added",
    "milestone_renamed",
    "milestone_done",
    "milestone_reopened",
    "milestone_due",
    "milestone_deleted",
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

  static build(rows: readonly TimelineRow[], prior: readonly PriorInforRow[], currentInfor: number | null): Timeline {
    const dated = HistoryEntries.group(rows)
      .map((g) => ({ key: `${g.changedAt.getTime()}|${g.changedBy}`, at: g.changedAt, meta: C.meta(ReportFormat.dateTimeEt(g.changedAt), UpdateTimeline.actor(g.changedBy)), lines: UpdateTimeline.lines(g.rows) }))
      .filter((e) => e.lines.length > 0);
    const datedPrior = prior.filter((p) => p.recordedAt).sort((a, b) => b.recordedAt!.getTime() - a.recordedAt!.getTime());
    const undated = prior.filter((p) => !p.recordedAt).sort((a, b) => b.number - a.number);
    const priorEntries: TimelineEntry[] = [...datedPrior, ...undated].map((p) => ({
      key: `prior|${p.number}`,
      at: p.recordedAt,
      meta: p.recordedAt ? C.meta(ReportFormat.dateTimeEt(p.recordedAt), C.TRACKER) : C.BEFORE_THIS_TRACKER,
      lines: [{ text: C.earlierInfor(p.number) }],
    }));
    const entries = [...dated, ...priorEntries.filter((e) => e.at)].sort((a, b) => b.at!.getTime() - a.at!.getTime());
    entries.push(...priorEntries.filter((e) => !e.at));
    const priorInforNumbers = UpdateTimeline.priorInforNumbers(rows, prior, currentInfor);
    return { entries, title: C.title(entries.length), priorInforNumbers, previously: C.previously(priorInforNumbers) };
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

  /** Who made the change: "Tracker" for system writes, else the person's name from their email. */
  static actor(changedBy: string): string {
    const by = changedBy.trim();
    if (!by || /^(system|cron|migration)\b/i.test(by)) return C.TRACKER;
    if (!by.includes("@")) return by;
    const local = by.split("@")[0];
    return /[._-]/.test(local) ? DisplayName.fromEmail(by) : by;
  }

  /** The lines for one save, in reading order. */
  static lines(rows: readonly TimelineRow[]): TimelineLine[] {
    const fields = new Set(rows.map((r) => r.field));
    const hasSteps = [...fields].some((f) => f.startsWith("milestone"));
    const rank = (f: string) => {
      const i = UpdateTimeline.ORDER.indexOf(f);
      return i < 0 ? UpdateTimeline.ORDER.length : i;
    };
    const out: TimelineLine[] = [];
    for (const row of [...rows].sort((a, b) => rank(a.field) - rank(b.field))) {
      if (UpdateTimeline.SILENT.has(row.field)) continue;
      if (hasSteps && UpdateTimeline.STEP_MIRRORS.has(row.field)) continue;
      // Naming a requester clears Not applicable in the same save; the name line says it.
      if (row.field === "requesterNotApplicable" && row.newValue !== "true" && fields.has("physicianChampion")) continue;
      const line = UpdateTimeline.line(row);
      if (line) out.push(line);
    }
    return out;
  }

  static line(row: TimelineRow): TimelineLine | null {
    const { field, oldValue: before, newValue: after } = row;
    const label = UpdateTimeline.label(field);
    const F = MilestoneRules.FIELDS;
    switch (field) {
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
        return { text: after === "true" ? C.INCLUDED_IN_REPORT : C.EXCLUDED_FROM_REPORT };
      case "requesterNotApplicable":
        return { text: after === "true" ? C.REQUESTER_NA : C.REQUESTER_NA_CLEARED };
    }
    if (field === "serviceArea" && row.comment && UpdateTimeline.DEPARTMENT_DELETED.test(row.comment) && before && after) {
      return { text: C.movedOnDelete(before, after) };
    }
    if (row.comment === UpdateTimeline.PEOPLE_RENAME_COMMENT && before && after) {
      return { text: C.renamedOnPeoplePage(label, before, after) };
    }
    if (UpdateTimeline.LONG_TEXT.has(field)) return { text: C.updated(label), change: { before, after } };
    const b = UpdateTimeline.value(field, before);
    const a = UpdateTimeline.value(field, after);
    if (b !== null && a !== null) return { text: C.changed(label, b, a) };
    if (a !== null) return { text: C.set(label, a) };
    if (b !== null) return { text: C.cleared(label, b) };
    return null;
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

  /** "Go-live: 2026-10-01" (MilestoneRules.dueLabel) -> parts. */
  private static dueParts(label: string | null): { name: string; due: string } | null {
    const m = label ? /^(.*): (\d{4}-\d{2}-\d{2})$/.exec(label) : null;
    return m ? { name: m[1], due: m[2] } : null;
  }
}
