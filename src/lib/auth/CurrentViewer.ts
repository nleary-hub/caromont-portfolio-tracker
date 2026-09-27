import { redirect } from "next/navigation";
import { auth } from "@/auth";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { SessionAccess } from "@/lib/auth/SessionAccess";

/** Resolves the viewer for the current request from the Auth.js session. Server only. */
export class CurrentViewer {
  /**
   * Null when there is no session or the email is no longer allowed. A session still on a temporary password is sent
   * to /set-password (the proxy does this too, but a sign-in's own redirect renders its target without the proxy).
   */
  static async get(): Promise<(Viewer & { name: string | null }) | null> {
    const session = await auth();
    if (SessionAccess.mustChangePassword(session)) redirect(SessionAccess.SET_PASSWORD_PATH);
    const viewer = SessionAccess.viewer(session);
    return viewer ? { ...viewer, name: session?.user?.name ?? null } : null;
  }
}
