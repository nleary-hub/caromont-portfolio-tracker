import { notFound, redirect } from "next/navigation";
import { auth } from "@/auth";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { SessionAccess } from "@/lib/auth/SessionAccess";

/**
 * Server-side admin enforcement for the CSV import page, its Server Functions and download routes.
 * Non-admins get a 404. Uses `SessionAccess` (ADMIN_EMAILS; a Google admin must also be on ALLOWED_EMAILS, a
 * password admin needs an active account), re-evaluated on every call. A session still on a temporary password is
 * sent to /set-password, like every other admin page.
 */
export class AdminGate {
  /** The signed-in admin as a viewer (for line scope and the admin menu), or null. */
  static async adminViewer(): Promise<(Viewer & { isAdmin: true }) | null> {
    const session = await auth();
    if (SessionAccess.mustChangePassword(session)) redirect(SessionAccess.SET_PASSWORD_PATH);
    const viewer = SessionAccess.viewer(session);
    return viewer?.isAdmin ? { email: viewer.email, isAdmin: true } : null;
  }

  /** The signed-in admin's email (lowercased), or null. */
  static async adminEmail(): Promise<string | null> {
    return (await AdminGate.adminViewer())?.email ?? null;
  }

  /** Returns the admin viewer or throws Next's 404. */
  static async requireAdminViewer(): Promise<Viewer & { isAdmin: true }> {
    const viewer = await AdminGate.adminViewer();
    if (!viewer) notFound();
    return viewer;
  }

  /** Returns the admin's email or throws Next's 404. */
  static async requireAdmin(): Promise<string> {
    return (await AdminGate.requireAdminViewer()).email;
  }
}
