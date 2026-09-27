/**
 * The dashboard's "Generate PDF now" link (/api/reports/preview). For a viewer limited to some departments it
 * carries the departments they are viewing (their dashboard filter); the server keeps only the ones they have
 * (DraftReportService). Admins' link has no departments (their PDF follows the admin report setting, as before).
 */
export class OnDemandPdfLink {
  static readonly PATH = "/api/reports/preview";

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
