import { ServiceLine } from "@/lib/domain/ServiceLine";

/**
 * The Contracts lead pick-list rules. The list is per service line (service_line.contractsLeads); callers pass
 * the active line's list. The default argument is CVPSL's seeded list (for code without a database).
 */
export class ContractsLead {
  /** Prefix of the display line under owner and requester: "Contracts Shea Waldron". */
  static readonly PREFIX = "Contracts";

  static options(list: readonly string[] = ServiceLine.CVPSL_CONTRACTS_LEADS): readonly string[] {
    return list;
  }

  /**
   * Canonical name for a list entry (case and whitespace tolerant), null for blank, undefined when the
   * value is not on the list.
   */
  static resolve(value: string | null | undefined, list: readonly string[] = ServiceLine.CVPSL_CONTRACTS_LEADS): string | null | undefined {
    if (value === null || value === undefined) return null;
    const key = ContractsLead.key(value);
    if (key === "") return null;
    return ContractsLead.options(list).find((n) => ContractsLead.key(n) === key);
  }

  static invalidMessage(value: string, list: readonly string[] = ServiceLine.CVPSL_CONTRACTS_LEADS): string {
    if (list.length === 0) return `"${value.trim()}" is not a contracts lead. This service line has no contracts leads yet (leave blank)`;
    return `"${value.trim()}" is not a contracts lead. Use one of: ${ContractsLead.options(list).join(", ")} (or leave blank)`;
  }

  /** The drawer picker's options: the line's list A to Z (display only; the stored list order is unchanged). */
  static pickerOptions(list: readonly string[] = ServiceLine.CVPSL_CONTRACTS_LEADS): string[] {
    return [...ContractsLead.options(list)].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
  }

  private static key(value: string): string {
    return value.trim().replace(/\s+/g, " ").toLowerCase();
  }
}
