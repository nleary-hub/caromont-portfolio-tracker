/** Copy of Admin > Report contents (was "Line settings"). */
export class ReportSettingsCopy {
  /** Gray pointer where the People section was: "Contracts leads are now on the People page", with "People" linked. */
  static readonly POINTER_BEFORE = "Contracts leads are now on the ";
  static readonly POINTER_LINK = "People";
  static readonly POINTER_AFTER = " page";

  static pointerText(): string {
    return `${ReportSettingsCopy.POINTER_BEFORE}${ReportSettingsCopy.POINTER_LINK}${ReportSettingsCopy.POINTER_AFTER}`;
  }
}
