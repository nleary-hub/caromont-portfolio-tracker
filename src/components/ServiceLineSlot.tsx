import type { Viewer } from "@/lib/auth/AdminPolicy";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { Db } from "@/lib/db/Db";
import type { ServiceLineScope } from "@/lib/domain/ServiceLine";
import { ServiceLineLabel } from "./ServiceLineLabel";
import { ServiceLineSwitcher } from "./ServiceLineSwitcher";

/** Server-side: the switcher for admins, the plain line name for everyone else. */
export async function ServiceLineSlot({ viewer, active }: { viewer: Viewer | null | undefined; active: ServiceLineScope }) {
  if (!viewer?.isAdmin) return <ServiceLineLabel value={active} />;
  const lines = Db.isConfigured() ? await ServiceLineAccess.usableLines(viewer).catch(() => [active]) : [active];
  return <ServiceLineSwitcher lines={lines.length ? lines : [active]} active={active} />;
}
