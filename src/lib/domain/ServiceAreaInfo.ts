import { ServiceArea } from "@/generated/prisma/enums";

/** Grouping key: a department, or "Unassigned" for projects with no department (null). */
export type AreaGroup = ServiceArea | "Unassigned";

/** Service-area metadata. Declaration order == report order; Unassigned always sorts last. */
export class ServiceAreaInfo {
  static readonly UNASSIGNED = "Unassigned" as const;

  static readonly ORDER: readonly ServiceArea[] = [
    ServiceArea.Cath,
    ServiceArea.EP,
    ServiceArea.Echo,
    ServiceArea.CVSS,
    ServiceArea.INU,
    ServiceArea.CardioNeuro,
    ServiceArea.IR,
  ];

  private static readonly LABELS: Record<ServiceArea, string> = {
    Cath: "Cath",
    EP: "EP",
    Echo: "Echo",
    CVSS: "CVSS",
    INU: "INU",
    CardioNeuro: "CardioNeuro",
    IR: "IR",
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
    return area && area !== ServiceAreaInfo.UNASSIGNED ? ServiceAreaInfo.LABELS[area] : ServiceAreaInfo.UNASSIGNED;
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
