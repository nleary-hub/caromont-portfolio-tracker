/**
 * Year-end reports on a Vercel preview deployment (FreezeGuard): the disabled note on /reports and the Generate action's
 * error, one string. Kept out of FreezeGuard.ts and YearEndReportData.ts so the freeze graph is unchanged.
 */
export class YearEndPreviewCopy {
  static readonly NOTE = "Year-end reports are turned off on preview deployments.";
}
