import { AppConfig } from "@/lib/config/AppConfig";

/** The Contracts lead pick-list rules (list in AppConfig.CONTRACTS_LEADS). */
export class ContractsLead {
  /** Prefix of the display line under owner and requester: "Contracts Shea Waldron". */
  static readonly PREFIX = "Contracts";

  static options(): readonly string[] {
    return AppConfig.CONTRACTS_LEADS;
  }

  /**
   * Canonical name for a list entry (case and whitespace tolerant), null for blank, undefined when the
   * value is not on the list.
   */
  static resolve(value: string | null | undefined): string | null | undefined {
    if (value === null || value === undefined) return null;
    const key = ContractsLead.key(value);
    if (key === "") return null;
    return ContractsLead.options().find((n) => ContractsLead.key(n) === key);
  }

  static invalidMessage(value: string): string {
    return `"${value.trim()}" is not a contracts lead. Use one of: ${ContractsLead.options().join(", ")} (or leave blank)`;
  }

  private static key(value: string): string {
    return value.trim().replace(/\s+/g, " ").toLowerCase();
  }
}
