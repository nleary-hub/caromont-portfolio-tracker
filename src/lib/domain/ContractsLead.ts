import { ServiceLine } from "@/lib/domain/ServiceLine";

/**
 * The Contracts lead pick-list rules. The list is per service line (service_line.contractsLeads); callers pass
 * the active line's list. The default argument is CVPSL's seeded list (for code without a database).
 */
/** Contract lead role label (0066). */
export type LeadRole = "contractLead" | "projectManager";

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
  /** "No contract lead" (0065): like the requester's Not applicable, the line is hidden from the dashboard and report. */
  static readonly NONE_LABEL = "No contract lead";

  /** Per-project role label (0066). */
  static readonly ROLES = ["contractLead", "projectManager"] as const;
  static readonly ROLE_LABELS: Readonly<Record<LeadRole, string>> = { contractLead: "Contracts lead", projectManager: "Assigned project manager" };
  /** Line prefix on the dashboard and PDF ("Contracts:" stays exactly as before for the default role). */
  static readonly ROLE_PREFIXES: Readonly<Record<LeadRole, string>> = { contractLead: "Contracts", projectManager: "Assigned project manager" };
  static role(raw: unknown): LeadRole {
    return raw === "projectManager" ? "projectManager" : "contractLead";
  }
  /** Drawer toggle text (switches to the other label). */
  static toggleText(role: LeadRole): string {
    return role === "projectManager" ? "Use the Contracts lead label" : "Use the Assigned project manager label";
  }

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
