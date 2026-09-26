import { ServiceArea } from "@/generated/prisma/enums";

/** Service-area metadata. Declaration order == report order. */
export class ServiceAreaInfo {
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

  static label(area: ServiceArea): string {
    return ServiceAreaInfo.LABELS[area];
  }

  /** Position in report order (0-based). Unknown values sort last. */
  static rank(area: ServiceArea): number {
    const i = ServiceAreaInfo.ORDER.indexOf(area);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  }

  static isValid(value: unknown): value is ServiceArea {
    return typeof value === "string" && (ServiceAreaInfo.ORDER as readonly string[]).includes(value);
  }
}
