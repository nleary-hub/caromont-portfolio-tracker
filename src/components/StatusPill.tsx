import type { ProjectStatus } from "@/generated/prisma/enums";
import { ProjectStatusInfo } from "@/lib/domain/ProjectStatusInfo";

export function StatusPill({ status }: { status: ProjectStatus }) {
  return (
    <span className={`pill st-${status}`}>
      <i aria-hidden />
      {ProjectStatusInfo.label(status)}
    </span>
  );
}

export function Flags({ changed, overdue, long = false }: { changed: boolean; overdue: boolean; long?: boolean }) {
  if (!changed && !overdue) return <span className="text-muted">–</span>;
  return (
    <>
      {changed && <span className="flag fl-changed">◆ {long ? "Changed since last report" : "Changed"}</span>}
      {overdue && <span className="flag fl-overdue">! Overdue</span>}
    </>
  );
}
