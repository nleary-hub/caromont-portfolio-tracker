"use server";

import { Permissions } from "@/lib/permissions/Permissions";
import { revalidatePath } from "next/cache";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import { Db } from "@/lib/db/Db";
import { ReviewService } from "@/lib/services/ReviewService";

export type ReviewActionResult = { ok: true; count: number; skipped: number; at: string } | { ok: false; error: string };

/**
 * "Mark as reviewed" and its Undo. Reachable by direct POST, so the viewer comes from the session and every project is
 * re-checked against ProjectEditPolicy in ReviewService (projects the viewer may not edit are skipped, never written).
 */
async function run(label: string, fn: (viewer: NonNullable<Awaited<ReturnType<typeof CurrentViewer.get>>>) => Promise<{ ids: string[]; skipped: number; at: string }>): Promise<ReviewActionResult> {
  const viewer = await CurrentViewer.get();
  if (!viewer || !Permissions.can(viewer, "project.review")) return { ok: false, error: "Not authorized." };
  try {
    const r = await fn(viewer);
    if (r.ids.length === 0) return { ok: false, error: "Nothing was marked. You can only mark projects you can edit." };
    revalidatePath("/");
    revalidatePath("/admin/audit");
    return { ok: true, count: r.ids.length, skipped: r.skipped, at: r.at };
  } catch (e) {
    console.error(`Review action failed: ${label}`, e);
    return { ok: false, error: "Could not save the change." };
  }
}

export async function markProjectsReviewed(projectIds: string[], bulk: boolean): Promise<ReviewActionResult> {
  return run("mark reviewed", async (viewer) => ReviewService.mark(Db.client, viewer, await ServiceLineAccess.activeFor(viewer), Array.isArray(projectIds) ? projectIds : [], Boolean(bulk)));
}

export async function undoProjectsReviewed(projectIds: string[], at: string): Promise<ReviewActionResult> {
  return run("undo reviewed", async (viewer) => ReviewService.undo(Db.client, viewer, await ServiceLineAccess.activeFor(viewer), Array.isArray(projectIds) ? projectIds : [], String(at)));
}
