/** Display rules for the optional Infor request number (whole number 1 to 99999, shown as "REQ-5081"). */
export class InforNumber {
  static readonly PREFIX = "REQ-";
  /** Characters the fixed slot is sized for: "REQ-" plus 5 digits. */
  static readonly SLOT_CHARS = 9;

  /** "REQ-5081", or null when there is no number. */
  static format(value: number | null | undefined): string | null {
    return value === null || value === undefined ? null : `${InforNumber.PREFIX}${value}`;
  }
}
