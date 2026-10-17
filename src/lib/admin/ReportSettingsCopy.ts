/** Copy of Admin > Report contents (was "Line settings"). */
export class ReportSettingsCopy {
  /** Gray pointer where the People section was: "Contracts leads are now on the People page", with "People" linked. */
  static readonly POINTER_BEFORE = "Contracts leads are now on the ";
  static readonly POINTER_LINK = "People";
  static readonly POINTER_AFTER = " page";

  /** "Waiting on" line option (Report contents). */
  static readonly WAITING_LEGEND = "Blocked projects";
  static readonly WAITING_LABEL = "Add a \"Waiting on\" line under blocked projects";
  static readonly WAITING_HELP = "Lists each open blocker under the project's update. Projects with no open blockers print exactly as before.";

  static pointerText(): string {
    return `${ReportSettingsCopy.POINTER_BEFORE}${ReportSettingsCopy.POINTER_LINK}${ReportSettingsCopy.POINTER_AFTER}`;
  }
}
