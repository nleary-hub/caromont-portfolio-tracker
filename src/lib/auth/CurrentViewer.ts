import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { ActingViewer } from "@/lib/auth/ActingViewer";
import { SessionAccess } from "@/lib/auth/SessionAccess";
import { RoleResolver, type GateUser } from "@/lib/permissions/RoleResolver";

/** Resolves the viewer for the current request from the Auth.js session. Server only. */
export class CurrentViewer {
  /**
   * Null when there is no session or the email is no longer allowed. A session still on a temporary password is sent
   * to /set-password (the proxy does this too, but a sign-in's own redirect renders its target without the proxy).
   */
  static async get(): Promise<(GateUser & { name: string | null }) | null> {
    // A Claude connector request (ActingViewer, set only by /api/mcp after its own token check) acts for that person.
    const acting = ActingViewer.get();
    if (acting) return acting;
    const session = await auth();
    if (SessionAccess.mustChangePassword(session)) redirect(SessionAccess.SET_PASSWORD_PATH);
    const viewer = SessionAccess.viewer(session);
    if (!viewer) return null;
    // Roles & Permissions: the role and its keys ride along, so every check downstream can use Permissions.can.
    const user = await RoleResolver.resolve({ ...viewer, name: session?.user?.name ?? null });
    return user ? { ...user, name: session?.user?.name ?? null } : null;
  }
}
