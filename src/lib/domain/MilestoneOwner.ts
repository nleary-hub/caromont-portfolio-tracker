import { DefaultMilestone } from "@/lib/projects/DefaultMilestone";
import type { MilestoneCount } from "@/lib/domain/MilestoneProgress";
import type { ProjectStatus } from "@/generated/prisma/enums";

/** What the Milestone owner column shows for a row. */
export type MilestoneOwnerCell = { kind: "owner"; name: string } | { kind: "unassigned" } | { kind: "none" };

/** The row fields the rule reads (a DashboardRow or a ReportRow). */
export interface MilestoneOwnerSource {
  status: ProjectStatus;
  nextMilestone: string | null;
  nextMilestoneOwner?: string | null;
  milestoneProgress?: MilestoneCount | null;
}

/**
 * The Milestone owner column (Figma Bro's Option A, Nick, Oct 12, 2026): the owner of the next open milestone.
 * - Complete or Cancelled, every milestone done, no milestone, or the next step is the automatic "Project complete"
 *   milestone: a muted en dash "–" ("No open milestone"). The automatic milestone never has an owner.
 * - Otherwise the step owner, or "Unassigned" (italic amber).
 * Physician names ("Dr. Sarah J. Kim", "Sarah Kim, MD") show as "Dr. S. Kim" on screen and in the PDF; the full name
 * goes in the tooltip and aria-label.
 */
export class MilestoneOwner {
  static readonly DASH = "–";
  static readonly UNASSIGNED = "Unassigned";
  static readonly NONE_LABEL = "No open milestone";

  static cell(row: MilestoneOwnerSource): MilestoneOwnerCell {
    if (row.status === "Complete" || row.status === "Cancelled") return { kind: "none" };
    const count = row.milestoneProgress;
    if (count && count.total > 0 && count.done === count.total) return { kind: "none" };
    const next = row.nextMilestone?.trim();
    if (!next || next === DefaultMilestone.NAME) return { kind: "none" };
    const name = row.nextMilestoneOwner?.trim();
    return name ? { kind: "owner", name } : { kind: "unassigned" };
  }

  /** Sort/filter key: the owner name, "Unassigned", or null (no open milestone). */
  static key(row: MilestoneOwnerSource): string | null {
    const c = MilestoneOwner.cell(row);
    return c.kind === "owner" ? c.name : c.kind === "unassigned" ? MilestoneOwner.UNASSIGNED : null;
  }

  private static readonly CREDENTIALS = /,?\s+(MD|M\.D\.|DO|D\.O\.|PhD|Ph\.D\.|FACC|FACS|FACP|MBA|MPH|MS|DNP)\.?$/i;
  private static readonly TITLE = /^dr\.?\s+/i;

  static isPhysician(name: string): boolean {
    const n = name.trim();
    return MilestoneOwner.TITLE.test(n) || MilestoneOwner.CREDENTIALS.test(n);
  }

  /** "Dr. Sarah J. Kim" / "Sarah Kim, MD" → "Dr. S. Kim". Other names unchanged. */
  static short(name: string): string {
    const n = name.trim().replace(/\s+/g, " ");
    if (!MilestoneOwner.isPhysician(n)) return n;
    let bare = n.replace(MilestoneOwner.TITLE, "");
    while (MilestoneOwner.CREDENTIALS.test(bare)) bare = bare.replace(MilestoneOwner.CREDENTIALS, "");
    const words = bare.replace(/,$/, "").split(" ").filter(Boolean);
    if (words.length === 0) return n;
    if (words.length === 1) return `Dr. ${words[0]}`;
    return `Dr. ${words[0][0].toUpperCase()}. ${words[words.length - 1]}`;
  }

  /** "Sarah Kim" → "S. Kim" (the second rung of the name ladder when the full name does not fit). */
  static initialed(name: string): string {
    const words = name.trim().split(/\s+/);
    if (words.length < 2 || /^dr\.?$/i.test(words[0])) return name.trim();
    return `${words[0][0].toUpperCase()}. ${words.slice(1).join(" ")}`;
  }

  /** Text shown in the cell: the dash, "Unassigned", or the (physician-short) name. */
  static text(cell: MilestoneOwnerCell): string {
    return cell.kind === "none" ? MilestoneOwner.DASH : cell.kind === "unassigned" ? MilestoneOwner.UNASSIGNED : MilestoneOwner.short(cell.name);
  }

  /** Tooltip / aria-label: the full name, "Unassigned" or "No open milestone". */
  static label(cell: MilestoneOwnerCell): string {
    return cell.kind === "none" ? MilestoneOwner.NONE_LABEL : cell.kind === "unassigned" ? MilestoneOwner.UNASSIGNED : cell.name;
  }
}
