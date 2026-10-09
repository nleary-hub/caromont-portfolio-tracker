/** What the PHI guard looks for (obvious patient identifiers only; it is a guard rail, not a de-identification tool). */
export type PhiKind = "mrn" | "dob" | "ssn" | "phone" | "patient_name";

/**
 * Blocks obvious patient identifiers before any text is sent to an AI provider (and before a suggestion's text is
 * stored): numbers labeled as a medical record, account or patient ID number, dates of birth, Social Security numbers, phone numbers, and "pt" or "patient" followed by a
 * name. Pure and deterministic. Errs toward blocking: the user can always reword and try again.
 */
export class AiPhiGuard {
  private static readonly SSN = /\b\d{3}-\d{2}-\d{4}\b|\b(?:SSN|social security(?: number| no\.?| #)?)\b\s*[:#]?\s*\d/i;
  private static readonly PHONE = /(?:\+?1[\s.-]?)?(?:\(\d{3}\)\s?|\b\d{3}[\s.-])\d{3}[\s.-]\d{4}\b/;
  private static readonly DOB = /\b(?:DOB|D\.O\.B\.?|date of birth|birth\s?date|born on)\b/i;
  /**
   * Medical-record-number labels: MRN, MR#, medical record, record number/no./#, acct/account number/no./#, patient
   * ID / pt ID. A number counts as a possible MRN only next to one of these (a bare number, such as a quote or REQ
   * number, always passes).
   */
  private static readonly MRN_LABEL = String.raw`(?:MRN|MR\s?#|MR\s+(?:number|no\.?)|medical\s+record(?:\s+(?:number|no\.?|#))?|record\s+(?:number|no\.?|#)|acct\.?(?:\s*(?:number|no\.?|#))?|account\s*(?:number|no\.?|#)|(?:patient|pt)\.?\s*(?:ID|identifier)(?:\s*(?:number|no\.?|#))?)`;
  /** Label, then up to three short words, then a number of 3+ digits: "MRN 00123", "acct # is 44521", "patient ID for her: 12345". */
  private static readonly MRN_AFTER = new RegExp(String.raw`\b${AiPhiGuard.MRN_LABEL}(?![A-Za-z])[\s:#.=-]*(?:[A-Za-z]{1,12}[\s:#.=-]+){0,3}\d{3,}`, "i");
  /** A number of 3+ digits, then up to three short words, then the label: "00123456 (MRN)", "4455 is the account number". */
  private static readonly MRN_BEFORE = new RegExp(String.raw`(?<![\d$.,])\d{3,}(?![\d,.]\d)[\s(),:-]*(?:[A-Za-z]{1,12}[\s(),:-]+){0,3}${AiPhiGuard.MRN_LABEL}(?![A-Za-z])`, "i");
  /** "pt" or "patient" (any case), optional "name:", optional title, then a capitalized word. */
  private static readonly PATIENT = /\b(?:[Pp][Tt]|[Pp]atient|PATIENT)s?\.?\s*(?:[Nn]ame\s*)?[:#-]?\s+(?:(?:Mr|Mrs|Ms|Miss|Dr)\.?\s+)?([A-Z][a-zA-Z'\u2019-]+)/g;
  /** Capitalized words that commonly follow "patient" or "PT" in project notes and are not names. */
  private static readonly NOT_NAMES: ReadonlySet<string> = new Set(
    (
      "Access Advocate Advocates Billing Care Census Charges Clinic Days Department Education Engagement Experience Families Family Financial Flow Gym " +
      "Intake Logistics Monitoring Navigation Navigator Navigators Placement Portal Registration Relations Room Rooms Safety Satisfaction Scheduling " +
      "Services Staff Team Tracking Transport Throughput Volume Volumes Records Feedback Surveys Survey Rounds Rounding " +
      "The Then This That These Those We They It He She And But Or On In At For To Is Was Will Should Should Has Had"
    ).split(/\s+/),
  );

  static check(text: string): { ok: true } | { ok: false; kinds: PhiKind[] } {
    const kinds: PhiKind[] = [];
    if (AiPhiGuard.MRN_AFTER.test(text) || AiPhiGuard.MRN_BEFORE.test(text)) kinds.push("mrn");
    if (AiPhiGuard.DOB.test(text)) kinds.push("dob");
    if (AiPhiGuard.SSN.test(text)) kinds.push("ssn");
    if (AiPhiGuard.PHONE.test(text)) kinds.push("phone");
    if (AiPhiGuard.hasPatientName(text)) kinds.push("patient_name");
    return kinds.length ? { ok: false, kinds } : { ok: true };
  }

  private static hasPatientName(text: string): boolean {
    for (const m of text.matchAll(AiPhiGuard.PATIENT)) {
      if (!AiPhiGuard.NOT_NAMES.has(m[1])) return true;
    }
    return false;
  }
}
