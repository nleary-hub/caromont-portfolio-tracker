import { AdminPolicy, type Viewer } from "@/lib/auth/AdminPolicy";
import { EmailAllowlist } from "@/lib/auth/EmailAllowlist";

type Env = Record<string, string | undefined>;

/** The parts of an Auth.js session this app reads. */
export interface SessionLike {
  user?: { email?: string | null; name?: string | null; passwordAccount?: boolean; mustChangePassword?: boolean; accountAccess?: boolean } | null;
}

/**
 * Who may use the app for a given session.
 * - Google (and Microsoft, dev login): the email must be on ALLOWED_EMAILS, re-checked on every request (as before).
 * - Google with an admin-created account that isn't turned off (not on ALLOWED_EMAILS): the sign-in checked the
 *   account and the session re-checks it every 5 minutes (SessionPolicy). ALLOWED_EMAILS OR account, never account only.
 * - Email and password: the admin-created account is the permission. The session only exists after a database-checked
 *   password, and it re-checks the database every 5 minutes (SessionPolicy), so ALLOWED_EMAILS is not needed.
 * Admin rights are ADMIN_EMAILS either way (for Google through ALLOWED_EMAILS, the admin must be on ALLOWED_EMAILS, as before).
 * A password session with a temporary password may only reach /set-password until it is replaced.
 */
export class SessionAccess {
  static readonly SET_PASSWORD_PATH = "/set-password";

  /** A same-site path to continue to (never another host, never back to sign-in). */
  static safeNext(value: string | null | undefined): string {
    if (!value || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/";
    if (value.startsWith("/signin") || value.startsWith("/api/auth") || value.startsWith(SessionAccess.SET_PASSWORD_PATH)) return "/";
    return value;
  }

  static email(session: SessionLike | null | undefined): string | null {
    const e = session?.user?.email?.trim().toLowerCase();
    return e && /^[^@\s]+@[^@\s]+$/.test(e) ? e : null;
  }

  static allowed(session: SessionLike | null | undefined, env: Env = process.env): boolean {
    const email = SessionAccess.email(session);
    if (!email) return false;
    return session?.user?.passwordAccount === true || session?.user?.accountAccess === true || EmailAllowlist.isAllowed(email, env);
  }

  static mustChangePassword(session: SessionLike | null | undefined): boolean {
    return session?.user?.passwordAccount === true && session.user.mustChangePassword === true;
  }

  /** The viewer for pages, actions and routes: null when not allowed, or still on a temporary password. */
  static viewer(session: SessionLike | null | undefined, env: Env = process.env): Viewer | null {
    if (!SessionAccess.allowed(session, env) || SessionAccess.mustChangePassword(session)) return null;
    if (session?.user?.passwordAccount !== true && session?.user?.accountAccess !== true) return AdminPolicy.viewerFor(session?.user?.email, env);
    const email = SessionAccess.email(session)!;
    return { email, isAdmin: AdminPolicy.fromEnv(env).allows(email) };
  }
}
