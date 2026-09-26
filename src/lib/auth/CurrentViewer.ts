import { auth } from "@/auth";
import { AdminPolicy, type Viewer } from "@/lib/auth/AdminPolicy";

/** Resolves the viewer for the current request from the Auth.js session. Server only. */
export class CurrentViewer {
  /** Null when there is no session or the email is no longer allowlisted. */
  static async get(): Promise<(Viewer & { name: string | null }) | null> {
    const session = await auth();
    const viewer = AdminPolicy.viewerFor(session?.user?.email);
    return viewer ? { ...viewer, name: session?.user?.name ?? null } : null;
  }
}
