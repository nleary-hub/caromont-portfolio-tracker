import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { SessionAccess } from "@/lib/auth/SessionAccess";
import { RoleResolver, type GateUser } from "@/lib/permissions/RoleResolver";

/** Resolves the viewer for the current request from the Auth.js session. Server only. */
export class CurrentViewer {
  /**
   * Null when there is no session or the email is no longer allowed. A session still on a temporary password is sent
   * to /set-password (the proxy does this too, but a sign-in's own redirect renders its target without the proxy).
   */
  static async get(): Promise<(GateUser & { name: string | null }) | null> {
    const session = await auth();
    if (SessionAccess.mustChangePassword(session)) redirect(SessionAccess.SET_PASSWORD_PATH);
    const viewer = SessionAccess.viewer(session);
    if (!viewer) return null;
    // Roles & Permissions: the role and its keys ride along, so every check downstream can use Permissions.can.
    const user = await RoleResolver.resolve({ ...viewer, name: session?.user?.name ?? null });
    return user ? { ...user, name: session?.user?.name ?? null } : null;
  }
}
