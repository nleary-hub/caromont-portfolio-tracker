/** Writing Bot copy for department-level access (follow-up to per-line access): Access grid, panel, cards, audit. */
export class DepartmentAccessCopy {
  static readonly ALL_DEPARTMENTS = "All departments";
  static readonly HELPER_ON = "Includes departments added later.";
  static readonly HELPER_OFF = "Only the checked departments. New ones aren't added.";
  static readonly SAVE_ERROR = "Couldn't save access. Try again.";
  static readonly REMOVE_BUTTON = "Remove access";

  static readonly PROJECT_TITLE = "You don't have access to this project";
  static readonly PROJECT_BODY = "Ask an admin if you need it.";
  static readonly GO_TO_DASHBOARD = "Go to dashboard";

  /** Small gray text under a limited line's checkbox: "3 of 7". */
  static countText(granted: number, total: number): string {
    return `${granted} of ${total}`;
  }

  /** Screen reader label of a limited cell: "Jane Doe, CVPSL access, 3 of 7 departments". */
  static limitedCellLabel(name: string, shortName: string, granted: number, total: number): string {
    return `${name}, ${shortName} access, ${granted} of ${total} departments`;
  }

  static showDepartments(name: string): string {
    return `Show ${name}'s departments`;
  }

  static hideDepartments(name: string): string {
    return `Hide ${name}'s departments`;
  }

  static departmentCheckbox(name: string, department: string, shortName: string): string {
    return `${name}, ${department} in ${shortName}`;
  }

  static grantedToast(name: string, department: string, shortName: string): string {
    return `${name} can now see ${department} in ${shortName}.`;
  }

  static revokedToast(name: string, department: string, shortName: string): string {
    return `${name} can no longer see ${department} in ${shortName}.`;
  }

  static allOnToast(name: string, shortName: string): string {
    return `${name} can now see all ${shortName} departments.`;
  }

  static allOffToast(name: string, shortName: string): string {
    return `${name} now sees only the checked ${shortName} departments.`;
  }

  static removeLastTitle(name: string, shortName: string): string {
    return `Remove ${name}'s last ${shortName} department?`;
  }

  static removeLastBody(shortName: string): string {
    return `This also removes ${shortName}. They won't see its projects until an admin adds it again.`;
  }

  /** Audit log: a department grant moved when the department was deleted. */
  static movedAudit(name: string, from: string, to: string): string {
    return `${name}'s ${from} access moved to ${to} when ${from} was deleted.`;
  }
}
