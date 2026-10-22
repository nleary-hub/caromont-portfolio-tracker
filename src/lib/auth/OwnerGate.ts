import type { Viewer } from "@/lib/auth/AdminPolicy";
import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import { OwnerPolicy } from "@/lib/auth/OwnerPolicy";

/**
 * The one server-side check every AI entry point uses (Server Functions, the voice connect route and the AI pages):
 * the signed-in Owner, or null for anyone else (other admins, viewers, signed-out). Callers keep their own "not
 * authorized" answer (403 on routes, 404 on pages). Server only.
 */
export class OwnerGate {
  static async ownerViewer(): Promise<(Viewer & { name: string | null }) | null> {
    const viewer = await CurrentViewer.get();
    return OwnerPolicy.isOwner(viewer) ? viewer : null;
  }
}
