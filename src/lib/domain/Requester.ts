import { Assignee } from "@/lib/domain/Assignee";
import { PeopleDirectory } from "@/lib/people/PeopleDirectory";

/** How a requester cell renders: the name, blank (Not applicable), or muted "To assign" (not yet addressed). */
export interface RequesterDisplay {
  text: string;
  muted: boolean;
}

/**
 * The requester (stored as Project.physicianChampion) has three states:
 *  - a name;
 *  - Not applicable (requesterNotApplicable = true, name blank): renders blank;
 *  - not yet addressed (name blank, not NA): renders a muted "To assign".
 * Setting a name clears Not applicable and setting Not applicable clears the name.
 */
export class Requester {
  static readonly LABEL = "Requester";
  static readonly NOT_APPLICABLE = "Not applicable";
  private static readonly NA_WORDS: ReadonlySet<string> = new Set(["not applicable", "n/a", "na"]);

  /** "Not applicable", "N/A" or "NA" in any case (spaces tolerated). */
  static isNotApplicableText(value: string | null | undefined): boolean {
    if (typeof value !== "string") return false;
    return Requester.NA_WORDS.has(value.trim().replace(/\s+/g, " ").toLowerCase());
  }

  /** Display for a requester, or null when Not applicable (render nothing). */
  static display(name: string | null | undefined, notApplicable: boolean | null | undefined): RequesterDisplay | null {
    const n = name?.trim();
    if (n) return { text: n, muted: false };
    if (notApplicable) return null;
    return { text: Assignee.TO_ASSIGN, muted: true };
  }

  /** Distinct existing requester names, sorted (the drawer combobox options; see PeopleDirectory.requesters). */
  static suggestions(existing: readonly (string | null | undefined)[]): string[] {
    return PeopleDirectory.requesters(existing);
  }

  /** CSV cell text: the name, "Not applicable", or blank. */
  static cellText(name: string | null | undefined, notApplicable: boolean | null | undefined): string {
    const n = name?.trim();
    if (n) return n;
    return notApplicable ? Requester.NOT_APPLICABLE : "";
  }

  /**
   * Normalize a patch that touches the requester so the two fields stay consistent:
   * NA text in the name sets Not applicable; a name or a blank clears it; Not applicable = true clears the name.
   * Fields not in the patch stay absent (unchanged).
   */
  static normalizePatch<T extends { physicianChampion?: string | null; requesterNotApplicable?: boolean }>(patch: T): T {
    const out = { ...patch };
    if ("physicianChampion" in out) {
      const v = out.physicianChampion;
      if (Requester.isNotApplicableText(v)) {
        out.physicianChampion = null;
        out.requesterNotApplicable = true;
      } else if (out.requesterNotApplicable !== true) {
        // A name, or a blank ("Clear (To assign)"), leaves Not applicable.
        out.requesterNotApplicable = false;
      }
    }
    if (out.requesterNotApplicable === true) out.physicianChampion = null;
    return out;
  }
}
