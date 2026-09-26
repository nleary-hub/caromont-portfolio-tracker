import { EmailAllowlist } from "@/lib/auth/EmailAllowlist";

type Env = Record<string, string | undefined>;

/** The signed-in person a read or write is performed for. */
export interface Viewer {
  email: string;
  isAdmin: boolean;
}

export class AdminRequiredError extends Error {
  constructor() {
    super("Admin access required");
    this.name = "AdminRequiredError";
  }
}

/**
 * Admin role from ADMIN_EMAILS (same format as ALLOWED_EMAILS: exact emails or "@domain").
 * Fails closed: empty or missing = no admins. An admin must also be on ALLOWED_EMAILS.
 * Evaluated from the environment on every call, so removing someone takes effect on their next request.
 */
export class AdminPolicy {
  static fromEnv(env: Env = process.env): EmailAllowlist {
    return EmailAllowlist.parse(env.ADMIN_EMAILS);
  }

  static isAdmin(email: string | null | undefined, env: Env = process.env): boolean {
    return EmailAllowlist.isAllowed(email, env) && AdminPolicy.fromEnv(env).allows(email);
  }

  /** Viewer for an allowlisted email, or null when the email may not use the app at all. */
  static viewerFor(email: string | null | undefined, env: Env = process.env): Viewer | null {
    if (!email || !EmailAllowlist.isAllowed(email, env)) return null;
    return { email: email.trim().toLowerCase(), isAdmin: AdminPolicy.isAdmin(email, env) };
  }

  static assertAdmin(viewer: Viewer | null | undefined): asserts viewer is Viewer & { isAdmin: true } {
    if (!viewer?.isAdmin) throw new AdminRequiredError();
  }
}
