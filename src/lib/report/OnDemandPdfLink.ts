/**
 * The dashboard's "Generate PDF now" link (/api/reports/preview). For a non-admin it carries the departments they
 * are viewing (their dashboard filter); the server keeps only ones they can see (DraftReportService). Admins' link
 * has no departments (their PDF follows the admin report setting, as before).
 */
export class OnDemandPdfLink {
  static readonly PATH = "/api/reports/preview";

  /** The button's tooltip, for everyone (admins too). */
  static readonly TOOLTIP = "Download a draft PDF of the departments you're viewing. It isn't an official report, and nothing is saved or sent.";

  static href(departments?: readonly string[]): string {
    return departments?.length ? `${OnDemandPdfLink.PATH}?departments=${departments.map(encodeURIComponent).join(",")}` : OnDemandPdfLink.PATH;
  }

  /** `?departments=a,b`; absent or empty = undefined. */
  static parse(url: string): string[] | undefined {
    const raw = new URL(url).searchParams.get("departments");
    const ids = raw ? raw.split(",").map((s) => s.trim()).filter(Boolean) : [];
    return ids.length ? ids : undefined;
  }
}
