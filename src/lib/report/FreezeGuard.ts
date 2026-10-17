/** Thrown by every FreezeService write on a Vercel preview deployment (previews share the production database). */
export class FreezeDisabledError extends Error {
  static readonly MESSAGE = "Freezing is disabled on preview deployments.";
  constructor() {
    super(FreezeDisabledError.MESSAGE);
    this.name = "FreezeDisabledError";
  }
}

/**
 * Preview deployments share the production database, so a freeze there would write real snapshot, PDF and handoff
 * rows rendered by preview code, and production's cron would then treat the period as frozen. Read from
 * process.env (not a caller-supplied env) so no caller can opt out. Production and development are unaffected.
 */
export class FreezeGuard {
  static readonly NOTE = "Freezing is turned off on preview deployments.";

  static disabled(): boolean {
    return process.env.VERCEL_ENV === "preview";
  }

  static assertAllowed(): void {
    if (FreezeGuard.disabled()) throw new FreezeDisabledError();
  }
}
