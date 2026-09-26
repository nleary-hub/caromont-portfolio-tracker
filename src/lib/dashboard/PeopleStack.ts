import type { PeopleVisibility } from "@/lib/dashboard/DashboardColumnModel";
import { Assignee } from "@/lib/domain/Assignee";
import { ContractsLead } from "@/lib/domain/ContractsLead";
import { Requester } from "@/lib/domain/Requester";

/** One line of the People cell. */
export interface PeopleLine {
  kind: "owner" | "requester" | "contracts";
  /** Name, or "To assign". Contracts: the name only (the prefix is separate). */
  text: string;
  /** "To assign": regular weight in the secondary gray (never amber). */
  muted: boolean;
  /** "Contracts" (weight 500) before the name, contracts line only. */
  prefix: string | null;
  /** Full text for the tooltip ("Contracts Shea Waldron"). */
  title: string;
}

export interface PeopleFields {
  owner: string | null;
  physicianChampion: string | null;
  requesterNotApplicable?: boolean | null;
  contractsLead?: string | null;
}

/**
 * Lines of the stacked People cell, in the PDF owner-cell order: Owner, Requester, "Contracts Name".
 * Blank reads "To assign" (muted); a requester marked Not applicable drops its line; a field hidden in
 * the view settings drops its line. Uses the same display rules as the PDF (Assignee, Requester,
 * ContractsLead).
 */
export class PeopleStack {
  static lines(row: PeopleFields, show: PeopleVisibility): PeopleLine[] {
    const lines: PeopleLine[] = [];
    if (show.owner) {
      const text = Assignee.label(row.owner);
      lines.push({ kind: "owner", text, muted: !Assignee.isAssigned(row.owner), prefix: null, title: text });
    }
    if (show.requester) {
      const d = Requester.display(row.physicianChampion, row.requesterNotApplicable);
      if (d) lines.push({ kind: "requester", text: d.text, muted: d.muted, prefix: null, title: d.text });
    }
    if (show.contracts) {
      const lead = row.contractsLead ?? null;
      const text = Assignee.label(lead);
      lines.push({ kind: "contracts", text, muted: !Assignee.isAssigned(lead), prefix: ContractsLead.PREFIX, title: `${ContractsLead.PREFIX} ${text}` });
    }
    return lines;
  }
}
