import { ServiceArea } from "@/generated/prisma/enums";

/** Grouping key: a department, or "Unassigned" for projects with no department (null). */
export type AreaGroup = ServiceArea | "Unassigned";

/** Service-area metadata. Declaration order == report order; Unassigned always sorts last. */
export class ServiceAreaInfo {
  static readonly UNASSIGNED = "Unassigned" as const;

  /**
   * Departments in report order: the single source of truth is the ServiceArea enum in prisma/schema.prisma
   * (Postgres enum "ServiceArea"), read in schema order. A department added there shows up everywhere
   * (dashboard filter, admin "Departments in report", PDF sections and grid, counts) with no other change.
   */
  static readonly ORDER: readonly ServiceArea[] = Object.values(ServiceArea) as ServiceArea[];

  /** Display names that differ from the enum value; any other department shows its enum value. */
  private static readonly LABELS: Readonly<Partial<Record<ServiceArea, string>>> = {};

  /**
   * Other names accepted for a department on import (display names used in the tracker spreadsheet), in
   * addition to the enum values and labels. Matched ignoring case, spaces and punctuation.
   */
  static readonly ALIASES: Readonly<Record<string, ServiceArea>> = {
    "Cath Lab": "Cath",
    "EP Lab": "EP",
  };

  static all(): readonly ServiceArea[] {
    return ServiceAreaInfo.ORDER;
  }

  /** Every group in display order: the departments, then Unassigned. */
  static groups(): readonly AreaGroup[] {
    return [...ServiceAreaInfo.ORDER, ServiceAreaInfo.UNASSIGNED];
  }

  /** Group of a project's department (null = Unassigned). */
  static groupOf(area: ServiceArea | null | undefined): AreaGroup {
    return area ?? ServiceAreaInfo.UNASSIGNED;
  }

  static label(area: AreaGroup | null | undefined): string {
    return area && area !== ServiceAreaInfo.UNASSIGNED ? (ServiceAreaInfo.LABELS[area] ?? area) : ServiceAreaInfo.UNASSIGNED;
  }

  /** Position in report order (0-based). Unassigned (null) sorts after every department; unknown values last. */
  static rank(area: AreaGroup | null | undefined): number {
    if (!area || area === ServiceAreaInfo.UNASSIGNED) return ServiceAreaInfo.ORDER.length;
    const i = ServiceAreaInfo.ORDER.indexOf(area);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  }

  /** "Unassigned" (any case, spaces ignored) as typed in a CSV cell. */
  static isUnassignedText(value: string): boolean {
    return value.trim().toLowerCase() === "unassigned";
  }

  static isValid(value: unknown): value is ServiceArea {
    return typeof value === "string" && (ServiceAreaInfo.ORDER as readonly string[]).includes(value);
  }
}
