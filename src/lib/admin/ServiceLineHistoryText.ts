import type { ServiceArea } from "@/generated/prisma/enums";
import { ServiceAreaInfo } from "@/lib/domain/ServiceAreaInfo";

/** Plain-text rendering of service_line_history rows for the admin tables. */
export class ServiceLineHistoryText {
  static readonly ACTION_LABELS: Readonly<Record<string, string>> = {
    created: "Created",
    renamed: "Renamed",
    archived: "Archived",
    unarchived: "Unarchived",
    deleted: "Deleted",
    restored: "Restored",
    departments_changed: "Departments",
    contracts_leads_changed: "Contracts leads",
    migrated: "Service lines added",
  };

  static action(action: string): string {
    return ServiceLineHistoryText.ACTION_LABELS[action] ?? action;
  }

  /** "Name (SHORT)", a list, or "" for an empty value. */
  static value(value: unknown): string {
    if (value === null || value === undefined) return "";
    if (Array.isArray(value)) {
      if (value.length === 0) return "None";
      return value.map((v) => (ServiceAreaInfo.all().includes(v as ServiceArea) ? ServiceAreaInfo.label(v as ServiceArea) : String(v))).join(", ");
    }
    if (typeof value === "object") {
      const o = value as { name?: unknown; shortName?: unknown };
      if (typeof o.name === "string") return typeof o.shortName === "string" ? `${o.name} (${o.shortName})` : o.name;
      return "";
    }
    return String(value);
  }
}
