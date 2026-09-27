import type { DepartmentInfo } from "@/lib/domain/ServiceAreaInfo";

/** A department row as stored (migration 0018), structurally compatible with the Prisma model. */
export interface DepartmentRow {
  id: string;
  serviceLineId: string;
  name: string;
  shortName: string;
  position: number;
  legacyKey: string | null;
  archivedAt: Date | null;
  deletedAt: Date | null;
  deletedBy?: string | null;
  updatedAt?: Date;
  updatedBy?: string;
}

export interface DepartmentValue {
  name: string;
  shortName: string;
}

export type DepartmentField = keyof DepartmentValue | "confirm" | "moveTo" | "_form";

export class DepartmentValidationError extends Error {
  constructor(readonly errors: Partial<Record<DepartmentField, string>>) {
    super(Object.values(errors).join(" "));
    this.name = "DepartmentValidationError";
  }
}

/** Pure rules for departments: lengths, uniqueness per line, and the admin copy. Storage lives in DepartmentService. */
export class DepartmentRules {
  static readonly NAME_MAX = 40;
  static readonly SHORT_MAX = 12;

  static toInfo(row: Pick<DepartmentRow, "id" | "name" | "shortName" | "legacyKey" | "archivedAt" | "deletedAt">): DepartmentInfo {
    return {
      id: row.id,
      name: row.name,
      shortName: row.shortName,
      legacyKey: row.legacyKey ?? null,
      ...(row.archivedAt ? { archived: true } : {}),
      ...(row.deletedAt ? { deleted: true } : {}),
    };
  }

  /** Collapse runs of whitespace and trim. */
  static clean(value: unknown): string {
    return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  }

  /**
   * Validated value. `others` are the line's other departments not deleted (archived ones included): names and
   * short names are unique among them, ignoring case. Throws DepartmentValidationError with per-field messages.
   */
  static parse(raw: { name?: unknown; shortName?: unknown }, others: readonly Pick<DepartmentRow, "name" | "shortName">[], lineShort: string): DepartmentValue {
    const name = DepartmentRules.clean(raw.name);
    const shortName = DepartmentRules.clean(raw.shortName);
    const errors: Partial<Record<DepartmentField, string>> = {};
    const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    if (!name) errors.name = DepartmentCopy.NAME_REQUIRED;
    else if (name.length > DepartmentRules.NAME_MAX) errors.name = DepartmentCopy.NAME_TOO_LONG;
    else if (others.some((o) => same(o.name, name))) errors.name = DepartmentCopy.nameTaken(lineShort);
    if (!shortName) errors.shortName = DepartmentCopy.SHORT_REQUIRED;
    else if (shortName.length > DepartmentRules.SHORT_MAX) errors.shortName = DepartmentCopy.SHORT_TOO_LONG;
    else if (others.some((o) => same(o.shortName, shortName))) errors.shortName = DepartmentCopy.shortTaken(lineShort);
    if (Object.keys(errors).length) throw new DepartmentValidationError(errors);
    return { name, shortName };
  }

  /** Whether a deleted department can come back: no department not deleted uses its name or short name. */
  static restoreConflict(row: Pick<DepartmentRow, "name" | "shortName">, others: readonly Pick<DepartmentRow, "name" | "shortName">[]): boolean {
    const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    return others.some((o) => same(o.name, row.name) || same(o.shortName, row.shortName));
  }

  /** PDF headings print the short name in capitals (the section head style). */
  /** PDF section heading: the short name in its own casing ("Struct"). */
  static pdfHeading(shortName: string): string {
    return shortName;
  }

  /** Dashboard department heading: the short name in uppercase ("STRUCT"). */
  static dashboardHeading(shortName: string): string {
    return shortName.toUpperCase();
  }
}

/** Copy for the Departments admin page (Writing Bot), in one place so the page and tests agree. */
export class DepartmentCopy {
  static readonly PAGE_TITLE = "Departments";
  static readonly NEW_BUTTON = "+ New department";
  static readonly ORDER_NOTE = "This order sets the PDF and dashboard order. Unassigned always comes last.";
  static readonly EMPTY = "No departments yet. Add one to start assigning projects.";
  static readonly MOVED_TOAST = "Department moved";
  static readonly UNDO = "Undo";
  static readonly SAVED_TOAST = "Department saved.";
  static readonly COLUMNS = { name: "Name", shortName: "Short name", active: "Active projects", updated: "Updated" } as const;
  static readonly ARCHIVED_HEADING = (n: number) => `Archived (${n})`;
  static readonly MENU = { edit: "Edit", archive: "Archive", delete: "Delete", unarchive: "Unarchive" } as const;
  static readonly GRIP_TOOLTIP = "Drag to reorder.";

  static readonly NEW_TITLE = "New department";
  static readonly EDIT_TITLE = "Edit department";
  static readonly NAME_LABEL = "Name";
  static readonly NAME_HINT = "Shown in the filter and project pick-lists.";
  static readonly SHORT_LABEL = "Short name";
  static readonly SHORT_HINT = "Shown in PDF headings and the summary grid.";
  static readonly PREVIEW_LABEL = "Preview";
  static readonly ADMIN_SECTION = "Admin";
  static readonly SAVE = "Save";
  static readonly CANCEL = "Cancel";
  static readonly NAME_REQUIRED = "Name is required.";
  static readonly NAME_TOO_LONG = `Name must be ${DepartmentRules.NAME_MAX} characters or fewer.`;
  static readonly SHORT_REQUIRED = "Short name is required.";
  static readonly SHORT_TOO_LONG = `Short name must be ${DepartmentRules.SHORT_MAX} characters or fewer.`;

  static nameTaken(lineShort: string): string {
    return `Another department in ${lineShort} already uses this name.`;
  }

  static shortTaken(lineShort: string): string {
    return `Another department in ${lineShort} already uses this short name.`;
  }

  static previewPdf(shortName: string): string {
    return `PDF heading: ${DepartmentRules.pdfHeading(shortName)}`;
  }

  static previewDashboard(shortName: string): string {
    return `Dashboard heading: ${DepartmentRules.dashboardHeading(shortName)}`;
  }

  static previewGrid(shortName: string): string {
    return `Summary grid: ${shortName}`;
  }

  static archivedToast(name: string): string {
    return `${name} archived.`;
  }

  static unarchivedToast(name: string): string {
    return `${name} unarchived.`;
  }

  static restoredToast(name: string): string {
    return `${name} restored.`;
  }

  static archiveTitle(name: string): string {
    return `Archive ${name}?`;
  }

  static archiveBody(name: string, active: number): string {
    const first = "It will be hidden from filters, pick-lists and new projects.";
    if (active === 0) return first;
    if (active === 1) return `${first} Its 1 active project stays in ${name} and keeps showing in reports until it's reassigned or completed.`;
    return `${first} Its ${active} active projects stay in ${name} and keep showing in reports until they're reassigned or completed.`;
  }

  static readonly ARCHIVE_BUTTON = "Archive department";

  static deleteTitle(name: string): string {
    return `Delete ${name}?`;
  }

  static deleteBody(name: string, active: number): string {
    if (active === 0) return `This hides ${name} everywhere. Completed projects keep this department name. You can restore it from Audit.`;
    return `${name} has ${active} active ${active === 1 ? "project" : "projects"}. Move ${active === 1 ? "it" : "them"} to another department, or archive ${name} instead.`;
  }

  static moveLabel(active: number): string {
    return `Move ${active} ${active === 1 ? "project" : "projects"} to`;
  }

  static readonly MOVE_PLACEHOLDER = "Choose a department";

  static noOtherDepartment(name: string): string {
    return `There's no other department to move these projects to. Archive ${name} instead.`;
  }

  static readonly ARCHIVE_INSTEAD = "Archive instead";

  static confirmLabel(name: string): string {
    return `Type ${name} to confirm`;
  }

  static readonly CONFIRM_MISMATCH = "The name doesn't match.";
  static readonly DELETE_BUTTON = "Delete department";

  static deletedToast(name: string, moved: number, to: string | null): string {
    if (!moved || !to) return `${name} deleted.`;
    return `${name} deleted. ${moved} ${moved === 1 ? "project" : "projects"} moved to ${to}.`;
  }

  static readonly RESTORE_CONFLICT = "Another department in this line now uses this name or short name. Rename that one, then restore this one.";
}
