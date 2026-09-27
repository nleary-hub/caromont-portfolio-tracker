import { ContractsLead } from "@/lib/domain/ContractsLead";
import { Requester } from "@/lib/domain/Requester";

export type PeopleLabelKind = "owner" | "requester" | "contracts";

/**
 * Labels in front of each People cell line on the dashboard and in the PDF: "Owner: Name",
 * "Requester: Name", "Contracts: Name". A colon plus one normal space; the label is never cut.
 */
export class PeopleLabel {
  static readonly OWNER = "Owner:";
  static readonly REQUESTER = `${Requester.LABEL}:`;
  static readonly CONTRACTS = `${ContractsLead.PREFIX}:`;

  static of(kind: PeopleLabelKind): string {
    return kind === "owner" ? PeopleLabel.OWNER : kind === "requester" ? PeopleLabel.REQUESTER : PeopleLabel.CONTRACTS;
  }

  /** Full line text, e.g. "Contracts: To assign". */
  static line(kind: PeopleLabelKind, text: string): string {
    return `${PeopleLabel.of(kind)} ${text}`;
  }
}
