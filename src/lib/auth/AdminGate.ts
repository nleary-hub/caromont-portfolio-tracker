import { notFound } from "next/navigation";
import { auth } from "@/auth";
import { SessionAccess } from "@/lib/auth/SessionAccess";

/**
 * Server-side admin enforcement for the CSV import page, its Server Functions and download routes.
 * Non-admins get a 404. Uses `SessionAccess` (ADMIN_EMAILS; a Google admin must also be on ALLOWED_EMAILS, a
 * password admin needs an active account), re-evaluated on every call.
 */
export class AdminGate {
  /** The signed-in admin's email (lowercased), or null. */
  static async adminEmail(): Promise<string | null> {
    const session = await auth();
    const viewer = SessionAccess.viewer(session);
    return viewer?.isAdmin ? viewer.email : null;
  }

  /** Returns the admin's email or throws Next's 404. */
  static async requireAdmin(): Promise<string> {
    const email = await AdminGate.adminEmail();
    if (!email) notFound();
    return email;
  }
}
