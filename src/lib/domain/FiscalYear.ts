import { AppConfig } from "@/lib/config/AppConfig";

/** A fiscal year: label ("FY27") and inclusive YYYY-MM-DD bounds. */
export interface FiscalYearRange {
  label: string;
  start: string;
  end: string;
}

/**
 * Fiscal years start on the first day of AppConfig.FISCAL_YEAR_START_MONTH and are named by the calendar
 * year they end in: with a July start, 2026-07-01 to 2027-06-30 is FY27.
 */
export class FiscalYear {
  /** The fiscal year containing a YYYY-MM-DD date. */
  static of(date: string, startMonth: number = AppConfig.FISCAL_YEAR_START_MONTH): FiscalYearRange {
    const [y, mo] = date.split("-").map(Number);
    const startYear = mo >= startMonth ? y : y - 1;
    const endYear = startMonth === 1 ? startYear : startYear + 1;
    const pad = (n: number) => String(n).padStart(2, "0");
    const start = `${startYear}-${pad(startMonth)}-01`;
    const endMonth = startMonth === 1 ? 12 : startMonth - 1;
    const endDay = new Date(Date.UTC(endYear, endMonth, 0)).getUTCDate();
    return { label: `FY${pad(endYear % 100)}`, start, end: `${endYear}-${pad(endMonth)}-${pad(endDay)}` };
  }

  /** "Completed FY27 to date" */
  static completedLabel(label: string): string {
    return `Completed ${label} to date`;
  }

  static contains(range: Pick<FiscalYearRange, "start">, date: string, through: string): boolean {
    return date >= range.start && date <= through;
  }
}
