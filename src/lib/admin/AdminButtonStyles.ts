/** Shared admin dialog button classes (Departments and People). */
export class AdminButtonStyles {
  /**
   * Destructive confirm ("Delete department", "Remove"): solid off-track red with white text when enabled;
   * only the disabled state is the dim tint (dark off-track background, red text, reduced opacity).
   */
  static readonly DANGER =
    "h-7 rounded-control bg-(--status-off-track-light-fg) px-3 text-white type-table-strong hover:brightness-110 disabled:bg-(--status-off-track-dark-bg) disabled:text-danger disabled:opacity-50 disabled:hover:brightness-100";
}
