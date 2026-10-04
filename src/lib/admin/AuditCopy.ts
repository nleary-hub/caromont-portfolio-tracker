import { ReportColorScheme } from "@/lib/report/ReportColorScheme";

/**
 * Every string Admin > Recent changes (/admin/audit) shows for a change code: the CHANGE label and the words used in
 * the OLD / NEW summaries. Display only: stored history rows are never rewritten. Final wording from Writing Bot
 * goes here, and only here. No em dashes.
 */
export class AuditCopy {
  /** CHANGE cell label for each stored code (AuditEvent.field). Unknown codes fall back to AuditText.humanize. */
  static readonly LABELS: Readonly<Record<string, string>> = {
    // Project (admin-only history fields). startDate uses StartDate.AUDIT_CHANGE ("Start date changed").
    archivedAt: "Deleted at",
    deletedBy: "Deleted by",
    hiddenFromDashboard: "Hidden from dashboard",
    hiddenFromReport: "Hidden from report",
    // Completion date rules (task 5); the comment holds the source (completion:auto, completion:manual, ...).
    completion: "Completion date",
    // Dashboard view (view_settings_history)
    viewSettings: "Dashboard view",
    // Service lines (service_line_history)
    "serviceLine.migrated": "Service lines added",
    "serviceLine.created": "Service line added",
    "serviceLine.renamed": "Service line renamed",
    "serviceLine.archived": "Service line archived",
    "serviceLine.unarchived": "Service line unarchived",
    "serviceLine.deleted": "Service line deleted",
    "serviceLine.restored": "Service line restored",
    "serviceLine.departments_changed": "Service line departments changed",
    "serviceLine.contracts_leads_changed": "Contracts leads changed",
    "serviceLine.owners_changed": "Service line owners changed",
    "serviceLine.requesters_changed": "Service line requesters changed",
    // Milestone templates (milestone_template_history)
    "template.template_created": "Milestone template added",
    "template.template_renamed": "Milestone template renamed",
    "template.template_deleted": "Milestone template deleted",
    "template.templates_reordered": "Milestone template order changed",
    "template.item_added": "Milestone step added",
    "template.item_renamed": "Milestone step renamed",
    "template.item_deleted": "Milestone step deleted",
    "template.items_reordered": "Milestone step order changed",
    // Dashboard layout (line_layout_history)
    "layout.columns": "Dashboard columns changed",
    "layout.columns.reset": "Dashboard columns reset",
    "layout.rows": "Dashboard row order changed",
    "layout.rows.reset": "Dashboard row order reset",
    // Departments (department_history)
    "department.seeded": "Department added at setup",
    "department.created": "Department added",
    "department.edited": "Department edited",
    "department.moved": "Department order changed",
    "department.archived": "Department archived",
    "department.unarchived": "Department unarchived",
    "department.deleted": "Department deleted",
    "department.restored": "Department restored",
    // Report colors (report_options_history, #42). OLD / NEW already read plainly ("Navy solid", "Custom #2B4C7E", "None").
    "reportColors.bar": ReportColorScheme.COPY.auditBar,
    "reportColors.band": ReportColorScheme.COPY.auditBand,
  };

  /** Words inside the OLD / NEW summaries. */
  static readonly VALUES = {
    none: "None",
    yes: "Yes",
    no: "No",
    details: "Details",
    detailsOld: "Old (stored)",
    detailsNew: "New (stored)",
    columnWidthsChanged: "Column widths changed",
    defaultLayout: "Default layout",
    customOrder: "Custom order",
    defaultOrder: "Default order",
    noProjectsToMove: "No projects to move",
    hiddenStatuses: "Hidden statuses",
    hiddenColumns: "Hidden columns",
  } as const;

  /** "1 project", "3 projects". */
  static projects(n: number): string {
    return `${n} ${n === 1 ? "project" : "projects"}`;
  }

  /** department.deleted NEW: "Moved 3 projects to Cath Lab". */
  static movedProjects(n: number, to: string): string {
    return `Moved ${AuditCopy.projects(n)} to ${to}`;
  }

  /** template.item_added: "Vendor quote (step 2)". The only summary that shows a position. */
  static step(name: string, position: number): string {
    return `${name} (step ${position})`;
  }

  /** Template step rows, when the row names its template: "Vendor quote in EP lab refresh". */
  static inTemplate(summary: string, template: string): string {
    return `${summary} in ${template}`;
  }
}
