import type { ProjectStatus } from "@/generated/prisma/enums";
import { DateOnly } from "@/lib/domain/DateOnly";
import { ProjectStatusInfo } from "@/lib/domain/ProjectStatusInfo";
import { BlockerRules } from "@/lib/projects/BlockerRules";
import { ReportFormat } from "@/lib/report/pdf/ReportFormat";

/** An open Blocked-by dependency as the dashboard sees it (the blocker project must be one the viewer can see). */
export interface RowBlockerProject {
  id: string;
  name: string;
  status: ProjectStatus;
  /** The blocker project's due date (derived next step date, YYYY-MM-DD) or null. */
  dueDate: string | null;
  /** YYYY-MM-DD (America/New_York) the dependency was added. */
  since: string;
  /** Complete blocker and this viewer has not dismissed the "Clear it?" prompt. */
  prompt: boolean;
}

/** An open external blocker as the dashboard sees it. */
export interface RowBlockerExternal {
  waitingOn: string;
  description: string;
  since: string;
  followUpOn: string | null;
}

/** Per-row blocker data on the dashboard (DashboardRow.blockers; present only when there is something to show). */
export interface RowBlockers {
  blockedBy: RowBlockerProject[];
  external: RowBlockerExternal[];
  /** Open dependencies where this project is the blocker (blocked projects the viewer can see). */
  blocking: number;
}

export type BlockerFlagKind = "dueBeforeBlocker" | "blockerTrouble" | "followUpOverdue" | "blockerCancelled" | "blockedLong";

export interface BlockerFlag {
  kind: BlockerFlagKind;
  text: string;
}

type Row = { status: ProjectStatus; dueDate: string | null };

/**
 * Dashboard blocker signals (1b, Figma Bro spec). Pure: pills, the Blocked filter, the KPI tile and five computed
 * flags. Flags are words only: they never change a project's status, and nothing here is read by the report.
 */
export class BlockerSignals {
  static readonly LONG_DAYS = 30;
  static readonly PILL_MAX_CH = 28;
  static readonly FLAG_ORDER: readonly BlockerFlagKind[] = ["dueBeforeBlocker", "blockerTrouble", "followUpOverdue", "blockerCancelled", "blockedLong"];

  /** Open items: blocked-by projects plus open external blockers. */
  static openCount(b: RowBlockers | null | undefined): number {
    return b ? b.blockedBy.length + b.external.length : 0;
  }

  /** At least one open blocker or dependency (the Blocked filter and the tile). */
  static isBlocked(b: RowBlockers | null | undefined): boolean {
    return BlockerSignals.openCount(b) > 0;
  }

  private static all(b: RowBlockers): { name: string; since: string; kind: "project" | "external" }[] {
    return [...b.blockedBy.map((p) => ({ name: p.name, since: p.since, kind: "project" as const })), ...b.external.map((e) => ({ name: e.waitingOn, since: e.since, kind: "external" as const }))];
  }

  /** Days since the earliest open item started (today minus the earliest since/createdAt). Null when nothing is open. */
  static daysBlocked(b: RowBlockers | null | undefined, today: string): number | null {
    if (!b || !BlockerSignals.isBlocked(b)) return null;
    const earliest = BlockerSignals.all(b).map((x) => x.since).sort()[0];
    return BlockerRules.daysBetween(earliest, today);
  }

  /** The most recently started open item's name (blocker project name, or who an external blocker waits on). */
  static latestName(b: RowBlockers): string | null {
    const items = BlockerSignals.all(b);
    if (!items.length) return null;
    // Newest since first; ties: projects before externals, then name, so the pick is stable.
    return [...items].sort((x, y) => y.since.localeCompare(x.since) || (x.kind === y.kind ? x.name.localeCompare(y.name) : x.kind === "project" ? -1 : 1))[0].name;
  }

  static days(n: number): string {
    return `${n} day${n === 1 ? "" : "s"}`;
  }

  /** "Waiting on Northbeam Interiors · 12 days". Null when nothing is open. */
  static pillText(b: RowBlockers | null | undefined, today: string): string | null {
    if (!b) return null;
    const name = BlockerSignals.latestName(b);
    const days = BlockerSignals.daysBlocked(b, today);
    return name === null || days === null ? null : `Waiting on ${name} · ${BlockerSignals.days(days)}`;
  }

  /** Tooltip: every open item on its own line ("Imaging Scheduler Upgrade (project) since Oct 2"). */
  static pillTooltip(b: RowBlockers, today: string): string {
    const lines = [
      ...b.blockedBy.map((p) => `${p.name} (project, ${ProjectStatusInfo.label(p.status)}) since ${ReportFormat.shortDate(p.since, today)}`),
      ...b.external.map((e) => `${e.waitingOn}: ${e.description} since ${ReportFormat.shortDate(e.since, today)}`),
    ];
    return ["Waiting on:", ...lines].join("\n");
  }

  /** "Blocking 2" or null. */
  static blockingText(b: RowBlockers | null | undefined): string | null {
    return b && b.blocking > 0 ? `Blocking ${b.blocking}` : null;
  }

  static overdueFollowUps(b: RowBlockers | null | undefined, today: string): number {
    return b ? b.external.filter((e) => BlockerRules.isFollowUpOverdue(e.followUpOn, today)).length : 0;
  }

  /** KPI tile sub-line: "3 follow-ups overdue" (null at 0). */
  static overdueLine(n: number): string | null {
    return n > 0 ? `${n} follow-up${n === 1 ? "" : "s"} overdue` : null;
  }

  /** Complete blockers whose "Clear it?" prompt this viewer has not dismissed. */
  static prompts(b: RowBlockers | null | undefined): RowBlockerProject[] {
    return b ? b.blockedBy.filter((p) => p.prompt && p.status === "Complete") : [];
  }

  /** Completion banner text: "Imaging Scheduler Upgrade is Complete. Clear it?" */
  static promptText(name: string): string {
    return `${name} is Complete. Clear it?`;
  }

  /**
   * The five flags, in a fixed order. A closed (Complete or Cancelled) project gets none. Each flag reads only the
   * row's own status and due date and the open blocker items.
   */
  static flags(row: Row, b: RowBlockers | null | undefined, today: string): BlockerFlag[] {
    if (!b || !BlockerSignals.isBlocked(b) || ProjectStatusInfo.isClosed(row.status)) return [];
    const out: BlockerFlag[] = [];
    const openProjects = b.blockedBy.filter((p) => !ProjectStatusInfo.isClosed(p.status));
    // 1. Due before its blocker: the row's due date is earlier than an open blocker project's due date.
    if (row.dueDate) {
      const later = openProjects.filter((p) => p.dueDate && DateOnly.compare(p.dueDate, row.dueDate!) > 0).sort((x, y) => y.dueDate!.localeCompare(x.dueDate!))[0];
      if (later) out.push({ kind: "dueBeforeBlocker", text: `Due ${ReportFormat.shortDate(row.dueDate, today)}, before its blocker (due ${ReportFormat.shortDate(later.dueDate!, today)})` });
    }
    // 2. On track, but a blocker project is Off track or On hold.
    if (row.status === "OnTrack") {
      const trouble = openProjects.find((p) => p.status === "OffTrack") ?? openProjects.find((p) => p.status === "OnHold");
      if (trouble) out.push({ kind: "blockerTrouble", text: `On track, but its blocker is ${ProjectStatusInfo.label(trouble.status)}` });
    }
    // 3. An external follow-up date has passed (the earliest one).
    const overdue = b.external.filter((e) => BlockerRules.isFollowUpOverdue(e.followUpOn, today)).map((e) => e.followUpOn!).sort()[0];
    if (overdue) out.push({ kind: "followUpOverdue", text: `Follow-up overdue since ${ReportFormat.shortDate(overdue, today)}` });
    // 4. A blocker project was cancelled (it will never finish).
    if (b.blockedBy.some((p) => p.status === "Cancelled")) out.push({ kind: "blockerCancelled", text: "Blocker was Cancelled" });
    // 5. Blocked for 30 or more days.
    const days = BlockerSignals.daysBlocked(b, today);
    if (days !== null && days >= BlockerSignals.LONG_DAYS) out.push({ kind: "blockedLong", text: `Blocked for ${BlockerSignals.LONG_DAYS}+ days` });
    return out;
  }

  /** Tooltip / notice: one flag per line. */
  static flagsText(flags: readonly BlockerFlag[]): string {
    return flags.map((f) => f.text).join("\n");
  }
}
