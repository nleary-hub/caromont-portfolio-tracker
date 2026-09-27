import { AuditCopy } from "@/lib/admin/AuditCopy";
import { DashboardColumnModel, type DashboardColumnKey } from "@/lib/dashboard/DashboardColumnModel";
import { ProjectStatusInfo } from "@/lib/domain/ProjectStatusInfo";
import { ServiceAreaInfo, type DepartmentKey } from "@/lib/domain/ServiceAreaInfo";
import { ViewSettings } from "@/lib/domain/ViewSettings";
import { MilestoneRules } from "@/lib/domain/MilestoneRules";
import { StartDate } from "@/lib/projects/StartDate";
import type { ProjectStatus, ViewContext } from "@/generated/prisma/enums";
import type { ViewColumn } from "@/lib/domain/ViewSettings";

/** The parts of an AuditEvent (AdminAuditService) the text needs. */
export interface AuditTextEvent {
  kind: string;
  field: string;
  oldValue: string | null;
  newValue: string | null;
  /** Raw stored value when oldValue / newValue already hold display text (access, report colors). */
  oldRaw?: string | null;
  newRaw?: string | null;
  comment?: string | null;
  subject?: string;
  /** Template step rows: the template's name when the row's template still exists. */
  parent?: string | null;
}

type Side = "old" | "new";
type Obj = Record<string, unknown>;

/**
 * Display text for Admin > Recent changes: the CHANGE label and one short, plain summary per OLD / NEW cell, built
 * from the stored value at display time (history rows are never rewritten). Both sides use the same template.
 * Never returns JSON: unknown codes get a humanized label and a generic plain summary. Strings live in AuditCopy.
 */
export class AuditText {
  private static readonly WHEN = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/New_York" });
  private static readonly ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

  /** WHEN column and date-time values: "Sep 12, 2026, 11:00 AM ET". */
  static when(d: Date | null): string {
    return d ? `${AuditText.WHEN.format(d)} ET` : "–";
  }

  /** CHANGE cell. */
  static change(e: AuditTextEvent): string {
    if (e.kind === "access") return e.comment ?? AuditText.humanize(e.field);
    if (e.kind === "project" && e.field === StartDate.HISTORY_FIELD) return StartDate.AUDIT_CHANGE;
    return AuditCopy.LABELS[e.field] ?? MilestoneRules.FIELD_LABELS[e.field] ?? AuditText.humanize(e.field);
  }

  /** "department.merged_into" -> "Department merged into"; "serviceLine.fooBar" -> "Service line foo bar". */
  static humanize(code: string): string {
    const words = code
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(/[._\s-]+/)
      .filter(Boolean)
      .map((w) => w.toLowerCase());
    if (!words.length) return code;
    const s = words.join(" ");
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  /** The raw stored value for the Details disclosure (as stored, or "None" when empty). */
  static raw(e: AuditTextEvent, side: Side): string {
    const v = side === "old" ? (e.oldRaw !== undefined ? e.oldRaw : e.oldValue) : e.newRaw !== undefined ? e.newRaw : e.newValue;
    return v === null || v === undefined || v === "" ? AuditCopy.VALUES.none : v;
  }

  /** OLD / NEW cell text. */
  static summary(e: AuditTextEvent, side: Side): string {
    const text = AuditText.summaryOrNull(e, side);
    return text === null || text.trim() === "" ? AuditCopy.VALUES.none : text;
  }

  private static summaryOrNull(e: AuditTextEvent, side: Side): string | null {
    const stored = side === "old" ? e.oldValue : e.newValue;
    const rawText = side === "old" ? (e.oldRaw !== undefined ? e.oldRaw : e.oldValue) : e.newRaw !== undefined ? e.newRaw : e.newValue;
    const v = AuditText.parse(rawText);
    const action = e.field.slice(e.field.indexOf(".") + 1);
    switch (e.kind) {
      // Already plain: the from / to department names, and report colors labels ("Navy solid", "None").
      case "access":
      case "reportColors":
        return stored;
      case "project":
        return AuditText.project(e.field, rawText);
      case "viewSettings":
        return AuditText.viewSettings(v, e.subject);
      case "serviceLine":
        return AuditText.serviceLine(action, v);
      case "template":
        return AuditText.template(action, v, e.parent ?? null);
      case "layout":
        return AuditText.layout(action, v, side === "new" ? AuditText.parse(e.oldRaw !== undefined ? e.oldRaw : e.oldValue) : undefined);
      case "department":
        return AuditText.department(action, v, side);
      default:
        return AuditText.generic(v);
    }
  }

  /** Stored text to a value: JSON when it parses, the string otherwise. */
  static parse(text: string | null | undefined): unknown {
    if (text === null || text === undefined) return null;
    const t = text.trim();
    if (t === "" || t === "null") return null;
    if (/^[[{"]/.test(t) || t === "true" || t === "false" || /^-?\d+(\.\d+)?$/.test(t)) {
      try {
        return JSON.parse(t);
      } catch {
        return text;
      }
    }
    return text;
  }

  private static project(field: string, stored: string | null): string | null {
    if (stored === null || stored === "") return null;
    if (field === StartDate.HISTORY_FIELD) return StartDate.auditValue(stored);
    if (field === "hiddenFromDashboard" || field === "hiddenFromReport") return AuditText.generic(AuditText.parse(stored));
    return AuditText.generic(AuditText.parse(stored));
  }

  private static viewSettings(v: unknown, subject?: string): string | null {
    if (!AuditText.isObj(v)) return AuditText.generic(v);
    const statuses = Array.isArray(v.hiddenStatuses) ? v.hiddenStatuses.map((s) => AuditText.statusLabel(s)) : [];
    const parts = [`${AuditCopy.VALUES.hiddenStatuses}: ${AuditText.list(statuses)}`];
    if (Array.isArray(v.hiddenColumns) && v.hiddenColumns.length) {
      const ctx = subject && ViewSettings.isContext(subject) ? (subject as ViewContext) : null;
      const cols = v.hiddenColumns.map((c) => AuditText.viewColumnLabel(ctx, c));
      parts.push(`${AuditCopy.VALUES.hiddenColumns}: ${AuditText.list(cols)}`);
    }
    return parts.join("; ");
  }

  private static serviceLine(action: string, v: unknown): string | null {
    if (Array.isArray(v)) return AuditText.list(v.map((x) => (typeof x === "string" && ServiceAreaInfo.all().includes(x as DepartmentKey) ? ServiceAreaInfo.label(x as DepartmentKey) : AuditText.itemName(x))));
    if (v === null) return null;
    return AuditText.named(v) ?? AuditText.generic(v);
  }

  private static template(action: string, v: unknown, parent: string | null): string | null {
    if (v === null) return null;
    let text: string | null;
    if (Array.isArray(v)) text = AuditText.list(v.map((x) => AuditText.itemName(x)));
    else if (action === "item_added" && AuditText.isObj(v) && typeof v.name === "string" && typeof v.position === "number") text = AuditCopy.step(v.name, v.position);
    else if (AuditText.isObj(v) && typeof v.name === "string") text = v.name;
    else text = AuditText.generic(v);
    const isStep = action.startsWith("item_");
    return isStep && parent && text ? AuditCopy.inTemplate(text, parent) : text;
  }

  private static layout(action: string, v: unknown, oldForCompare: unknown): string | null {
    if (action === "columns.reset") return v === null ? AuditCopy.VALUES.defaultLayout : AuditText.columnOrder(v);
    if (action === "columns") {
      if (v === null) return null;
      const order = AuditText.orderOf(v);
      if (oldForCompare !== undefined && order && AuditText.sameOrder(order, AuditText.orderOf(oldForCompare))) return AuditCopy.VALUES.columnWidthsChanged;
      return AuditText.columnOrder(v);
    }
    if (action === "rows" || action === "rows.reset") {
      if (v === null) return action === "rows.reset" ? AuditCopy.VALUES.defaultOrder : null;
      if (AuditText.isObj(v)) return Object.values(v).some((x) => Array.isArray(x) && x.length > 0) ? AuditCopy.VALUES.customOrder : AuditCopy.VALUES.defaultOrder;
    }
    return AuditText.generic(v);
  }

  private static department(action: string, v: unknown, side: Side): string | null {
    if (action === "deleted" && side === "new") {
      if (AuditText.isObj(v) && typeof v.moved === "number" && v.moved > 0 && typeof v.movedTo === "string") return AuditCopy.movedProjects(v.moved, v.movedTo);
      if (v === null || (AuditText.isObj(v) && (v.moved === 0 || v.moved === undefined))) return AuditCopy.VALUES.noProjectsToMove;
    }
    if (v === null) return null;
    if (Array.isArray(v)) return AuditText.list(v.map((x) => AuditText.itemName(x)));
    if (action === "archived" || action === "unarchived") return AuditText.isObj(v) && typeof v.name === "string" ? v.name : AuditText.generic(v);
    return AuditText.named(v) ?? AuditText.generic(v);
  }

  /** Column order in human names: "Project, People, Status, Next milestone / Latest update, Due / Flags". */
  static columnOrder(v: unknown): string {
    const order = AuditText.orderOf(v);
    return order ? AuditText.list(order.map((k) => AuditText.columnName(k))) : AuditCopy.VALUES.none;
  }

  private static orderOf(v: unknown): string[] | null {
    return AuditText.isObj(v) && Array.isArray(v.order) ? v.order.filter((x): x is string => typeof x === "string") : null;
  }

  private static sameOrder(a: string[], b: string[] | null): boolean {
    return !!b && a.length === b.length && a.every((x, i) => x === b[i]);
  }

  private static columnName(key: string): string {
    try {
      const header = DashboardColumnModel.spec(key as DashboardColumnKey).header;
      if (header) return header;
    } catch {
      // unknown key: humanize below
    }
    return AuditText.humanize(key);
  }

  private static statusLabel(s: unknown): string {
    const label = typeof s === "string" ? ProjectStatusInfo.label(s as ProjectStatus) : undefined;
    return label ?? AuditText.humanize(String(s));
  }

  private static viewColumnLabel(ctx: ViewContext | null, c: unknown): string {
    const label = ctx && typeof c === "string" ? ViewSettings.columnLabel(ctx, c as ViewColumn) : undefined;
    return label ?? AuditText.humanize(String(c));
  }

  /** {name, shortName}: "Cath Lab (CATH)", or just "IR" when the short name is the name. Never the position. */
  static named(v: unknown): string | null {
    if (!AuditText.isObj(v) || typeof v.name !== "string") return null;
    const short = typeof v.shortName === "string" ? v.shortName.trim() : "";
    return short && short !== v.name.trim() ? `${v.name} (${short})` : v.name;
  }

  private static itemName(x: unknown): string {
    if (typeof x === "string") return x;
    return AuditText.named(x) ?? AuditText.generic(x) ?? "";
  }

  /** Comma-separated, or "None" when empty. */
  static list(items: readonly string[]): string {
    const clean = items.filter((s) => s && s.trim());
    return clean.length ? clean.join(", ") : AuditCopy.VALUES.none;
  }

  /** Any value in plain words: Yes / No, dates as "Sep 12, 2026, 11:00 AM ET", lists, "Key: value" pairs. Never JSON. */
  static generic(v: unknown): string | null {
    if (v === null || v === undefined) return null;
    if (typeof v === "boolean") return v ? AuditCopy.VALUES.yes : AuditCopy.VALUES.no;
    if (typeof v === "number") return String(v);
    if (typeof v === "string") {
      if (v === "true" || v === "false") return v === "true" ? AuditCopy.VALUES.yes : AuditCopy.VALUES.no;
      if (AuditText.ISO_INSTANT.test(v.trim())) {
        const d = new Date(v.trim());
        if (!Number.isNaN(d.getTime())) return AuditText.when(d);
      }
      return StartDate.auditValue(v) ?? v;
    }
    if (Array.isArray(v)) return AuditText.list(v.map((x) => AuditText.itemName(x)));
    if (AuditText.isObj(v)) {
      const named = AuditText.named(v);
      if (named) return named;
      const pairs = Object.entries(v)
        .filter(([k]) => k !== "position" && !/id$/i.test(k))
        .map(([k, x]) => `${AuditText.humanize(k)}: ${AuditText.generic(x) ?? AuditCopy.VALUES.none}`);
      return pairs.length ? pairs.join("; ") : null;
    }
    return String(v);
  }

  private static isObj(v: unknown): v is Obj {
    return typeof v === "object" && v !== null && !Array.isArray(v);
  }
}
