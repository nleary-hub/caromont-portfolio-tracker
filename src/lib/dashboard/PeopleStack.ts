import type { PeopleVisibility } from "@/lib/dashboard/DashboardColumnModel";
import { Assignee } from "@/lib/domain/Assignee";
import { PeopleLabel } from "@/lib/domain/PeopleLabel";
import { Requester } from "@/lib/domain/Requester";

/** One line of the People cell. */
export interface PeopleLine {
  kind: "owner" | "requester" | "contracts";
  /** "Owner:", "Requester:" or "Contracts:" (PeopleLabel). Never cut. */
  label: string;
  /** Name, or "To assign" (the label is separate). */
  text: string;
  /** "To assign": regular weight in the secondary gray (never amber). */
  muted: boolean;
  /** The owner line is primary (label 400, name 600, primary color); the others are secondary gray at 400. */
  primary: boolean;
  /** Tooltip: the full name (a long name is cut with an ellipsis). */
  title: string;
}

export interface PeopleFields {
  owner: string | null;
  physicianChampion: string | null;
  requesterNotApplicable?: boolean | null;
  contractsLead?: string | null;
}

/**
 * Lines of the stacked People cell, in the PDF owner-cell order: "Owner: Name", "Requester: Name",
 * "Contracts: Name".
 * Blank reads "To assign" (muted); a requester marked Not applicable drops its line; a field hidden in
 * the view settings drops its line. Uses the same display rules as the PDF (Assignee, Requester,
 * ContractsLead).
 */
export class PeopleStack {
  static lines(row: PeopleFields, show: PeopleVisibility): PeopleLine[] {
    const lines: PeopleLine[] = [];
    if (show.owner) {
      const text = Assignee.label(row.owner);
      lines.push({ kind: "owner", label: PeopleLabel.OWNER, text, muted: !Assignee.isAssigned(row.owner), primary: true, title: text });
    }
    if (show.requester) {
      const d = Requester.display(row.physicianChampion, row.requesterNotApplicable);
      if (d) lines.push({ kind: "requester", label: PeopleLabel.REQUESTER, text: d.text, muted: d.muted, primary: false, title: d.text });
    }
    if (show.contracts) {
      const lead = row.contractsLead ?? null;
      const text = Assignee.label(lead);
      lines.push({ kind: "contracts", label: PeopleLabel.CONTRACTS, text, muted: !Assignee.isAssigned(lead), primary: false, title: text });
    }
    return lines;
  }
}
