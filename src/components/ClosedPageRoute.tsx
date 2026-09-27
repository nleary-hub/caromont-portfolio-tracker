import { redirect } from "next/navigation";
import { signOut, SIGN_IN_PATH } from "@/auth";
import { loadProjectHistory } from "@/app/actions/history";
import { restoreCancelledProject } from "@/app/actions/closed";
import { DepartmentAccess } from "@/lib/access/DepartmentAccess";
import { LineGate } from "@/lib/access/LineGate";
import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import { ClosedPageData } from "@/lib/closed/ClosedPageData";
import { ClosedPageModel, type ClosedPageKind } from "@/lib/closed/ClosedPageModel";
import { DateOnly } from "@/lib/domain/DateOnly";
import { DepartmentFilter } from "@/lib/domain/DepartmentFilter";
import { AdminMenuSlot } from "./AdminMenuSlot";
import { ClosedProjectsView, type ClosedViewDemo } from "./ClosedProjectsView";
import { NoAccessCard } from "./NoAccessCard";
import { ServiceLineSlot } from "./ServiceLineSlot";

type SearchParams = Record<string, string | string[] | undefined>;

const signOutAction = async () => {
  "use server";
  await signOut({ redirectTo: SIGN_IN_PATH });
};

/**
 * The Completed and Cancelled pages (one layout). Same gate as the dashboard: signed in, then line access (no line =
 * the no-access card; ?line= names a line). Rows come from the viewer's active line only; admin-only parts (Restore
 * to active) are decided here on the server and enforced again in the action and the service.
 */
export class ClosedPageRoute {
  /** Review and screenshot deep links (?demo=menu:<id> etc.), outside production builds only. */
  static demo(params: SearchParams): ClosedViewDemo | undefined {
    if (process.env.NODE_ENV === "production" && process.env.CLOSED_PAGE_DEMO !== "1") return undefined;
    const raw = typeof params.demo === "string" ? params.demo : "";
    const [what, id] = raw.split(":");
    if (what === "menu" && id) return { menuOpenFor: id };
    if (what === "drawer" && id) return { drawerFor: id };
    if (what === "confirm" && id) return { confirmFor: id };
    if (what === "fy") return { fyOpen: true };
    return undefined;
  }

  static async render(kind: ClosedPageKind, searchParams: Promise<SearchParams>) {
    const viewer = await CurrentViewer.get();
    if (!viewer) redirect(SIGN_IN_PATH);
    const params = await searchParams;
    const gate = await LineGate.forPage(viewer, params.line, kind.path);
    if (gate.kind === "switched") redirect(gate.to);
    if (gate.kind === "none") return <NoAccessCard email={viewer.email} signOutAction={signOutAction} />;
    if (gate.kind === "lacks") return <NoAccessCard email={viewer.email} signOutAction={signOutAction} line={gate.requested} goTo={{ shortName: gate.first.shortName, href: LineGate.href(kind.path, gate.first.shortName) }} />;
    const { scope, lines } = gate;
    const today = DateOnly.today();
    const options = DepartmentFilter.optionsFor(scope);
    const data = await ClosedPageData.load(viewer, kind.status, today, scope);
    const canRestore = viewer.isAdmin && kind.status === "Cancelled";
    return (
      <ClosedProjectsView
        // A line switch remounts the page (filters reset to the line's own).
        key={scope.id}
        kind={kind}
        rows={data.rows}
        today={today}
        initialView={ClosedPageModel.parse(params, today, options, scope.departments)}
        options={options}
        list={scope.departments}
        limited={DepartmentAccess.isLimited(scope)}
        restore={canRestore ? data.restore : null}
        {...(canRestore ? { restoreAction: restoreCancelledProject } : {})}
        historyAction={loadProjectHistory}
        lineSlot={<ServiceLineSlot viewer={viewer} active={scope} lines={lines} />}
        adminSlot={<AdminMenuSlot viewer={viewer} />}
        loadError={data.error}
        demo={ClosedPageRoute.demo(params)}
      />
    );
  }
}
