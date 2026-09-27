/** Audit log wording for line_layout_history actions. */
export class AuditLayoutText {
  private static readonly ACTIONS: Readonly<Record<string, string>> = {
    columns: "columns changed",
    "columns.reset": "columns reset",
    rows: "row order changed",
    "rows.reset": "row order reset",
  };

  static action(action: string): string {
    return AuditLayoutText.ACTIONS[action] ?? action;
  }
}
