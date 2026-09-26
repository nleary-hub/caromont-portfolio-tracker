/** Structured one-line logs for the freeze and delivery path (visible in Vercel runtime logs). */
export class ReportLog {
  static info(event: string, data: Record<string, unknown> = {}): void {
    console.info(JSON.stringify({ scope: "report", level: "info", event, ...data }));
  }

  static warn(event: string, data: Record<string, unknown> = {}): void {
    console.warn(JSON.stringify({ scope: "report", level: "warn", event, ...data }));
  }

  static error(event: string, data: Record<string, unknown> = {}): void {
    console.error(JSON.stringify({ scope: "report", level: "error", event, ...data }));
  }
}
