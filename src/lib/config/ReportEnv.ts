export type EnvSource = Record<string, string | undefined>;

export interface DriveEnv {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Optional: when empty the app finds or creates its own folder (drive.file can only see app-created files). */
  folderId: string | null;
}

/** Report freeze and delivery settings from the environment. Everything fails closed when unset. */
export class ReportEnv {
  static readonly MIN_SECRET_LENGTH = 32;
  private static readonly EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

  private static value(env: EnvSource, key: string): string | null {
    const v = env[key]?.trim();
    return v ? v : null;
  }

  /** Bearer secret for /api/cron/freeze (Vercel sends it automatically when CRON_SECRET is set). */
  static cronSecret(env: EnvSource = process.env): string | null {
    return ReportEnv.value(env, "CRON_SECRET");
  }

  /** HMAC key for the signed fallback links. Too short counts as unset. */
  static shareLinkSecret(env: EnvSource = process.env): string | null {
    const v = ReportEnv.value(env, "SHARE_LINK_SECRET");
    return v && v.length >= ReportEnv.MIN_SECRET_LENGTH ? v : null;
  }

  /** Absolute base URL for links in handoff.json and signed links, without a trailing slash. */
  static baseUrl(env: EnvSource = process.env): string | null {
    const explicit = ReportEnv.value(env, "APP_BASE_URL");
    if (explicit) return explicit.replace(/\/+$/, "");
    const vercel = ReportEnv.value(env, "VERCEL_PROJECT_PRODUCTION_URL");
    return vercel ? `https://${vercel.replace(/^https?:\/\//, "").replace(/\/+$/, "")}` : null;
  }

  /** Single address for handoff.json (the app never sends email). Null when unset or not one valid address. */
  static reportRecipient(env: EnvSource = process.env): string | null {
    const v = ReportEnv.value(env, "REPORT_RECIPIENT_EMAIL");
    return v && ReportEnv.EMAIL_RE.test(v) ? v : null;
  }

  static drive(env: EnvSource = process.env): DriveEnv | null {
    const clientId = ReportEnv.value(env, "GOOGLE_DRIVE_CLIENT_ID");
    const clientSecret = ReportEnv.value(env, "GOOGLE_DRIVE_CLIENT_SECRET");
    const refreshToken = ReportEnv.value(env, "GOOGLE_DRIVE_REFRESH_TOKEN");
    if (!clientId || !clientSecret || !refreshToken) return null;
    return { clientId, clientSecret, refreshToken, folderId: ReportEnv.value(env, "GOOGLE_DRIVE_FOLDER_ID") };
  }
}
