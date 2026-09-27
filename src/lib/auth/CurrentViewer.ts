import { auth } from "@/auth";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { SessionAccess } from "@/lib/auth/SessionAccess";

/** Resolves the viewer for the current request from the Auth.js session. Server only. */
export class CurrentViewer {
  /** Null when there is no session, the email is no longer allowed, or a temporary password still has to be replaced. */
  static async get(): Promise<(Viewer & { name: string | null }) | null> {
    const session = await auth();
    const viewer = SessionAccess.viewer(session);
    return viewer ? { ...viewer, name: session?.user?.name ?? null } : null;
  }
}
