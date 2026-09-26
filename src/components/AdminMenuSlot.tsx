import type { Viewer } from "@/lib/auth/AdminPolicy";
import { AdminMenu } from "@/lib/admin/AdminMenu";
import { AdminMenuButton } from "./AdminMenuButton";

/**
 * Server-side gate for the admin menu on server-rendered pages. Renders nothing (no markup, no items
 * in the payload) unless `AdminPolicy` says the viewer is an admin.
 */
export function AdminMenuSlot({ viewer }: { viewer: Viewer | null | undefined }) {
  const items = AdminMenu.itemsFor(viewer);
  return items ? <AdminMenuButton items={items} /> : null;
}
