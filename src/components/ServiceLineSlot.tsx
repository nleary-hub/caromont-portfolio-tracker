import type { Viewer } from "@/lib/auth/AdminPolicy";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { Db } from "@/lib/db/Db";
import type { ServiceLineScope } from "@/lib/domain/ServiceLine";
import { ServiceLineLabel } from "./ServiceLineLabel";
import { ServiceLineSwitcher } from "./ServiceLineSwitcher";

/**
 * Server-side: the switcher for admins (with Manage service lines) and for anyone with two or more lines; the plain
 * line name for someone with exactly one line. Only the viewer's own lines are listed.
 */
export async function ServiceLineSlot({ viewer, active, lines: given }: { viewer: Viewer | null | undefined; active: ServiceLineScope; lines?: ServiceLineScope[] }) {
  if (!viewer) return <ServiceLineLabel value={active} />;
  const lines = given ?? (Db.isConfigured() ? await ServiceLineAccess.usableLines(viewer).catch(() => [active]) : [active]);
  if (!viewer.isAdmin && lines.length < 2) return <ServiceLineLabel value={active} />;
  return <ServiceLineSwitcher lines={lines.length ? lines : [active]} active={active} manage={viewer.isAdmin} />;
}
