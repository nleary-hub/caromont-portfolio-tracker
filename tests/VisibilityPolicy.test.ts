import { describe, expect, it } from "vitest";
import { ViewSettings } from "@/lib/domain/ViewSettings";
import { VisibilityPolicy } from "@/lib/visibility/VisibilityPolicy";
import { Factory } from "./helpers/factories";

describe("VisibilityPolicy", () => {
  const live = Factory.project({ id: "live" });
  const done = Factory.project({ id: "done", status: "Complete", nextMilestone: null });
  const hidDash = Factory.project({ id: "hidDash", hiddenFromDashboard: true });
  const hidRep = Factory.project({ id: "hidRep", hiddenFromReport: true });
  const notInReport = Factory.project({ id: "notInReport", includeInReport: false });
  const deleted = Factory.project({ id: "deleted", archivedAt: new Date(), deletedBy: "admin@example.org" });
  const all = [live, done, hidDash, hidRep, notInReport, deleted];

  it("per-project hide applies per context; deleted and hidden statuses are invisible everywhere", () => {
    const dash = VisibilityPolicy.visibleProjects(all, "dashboard", ViewSettings.defaults("dashboard")).map((p) => p.id);
    const rep = VisibilityPolicy.visibleProjects(all, "report", ViewSettings.defaults("report")).map((p) => p.id);
    expect(dash).toEqual(["live", "hidRep", "notInReport"]);
    expect(rep).toEqual(["live", "hidDash"]);
    const showAll = ViewSettings.normalize("dashboard", { hiddenStatuses: [] });
    // Closed statuses ignore the settings: Complete only while completed in the period, Cancelled never.
    expect(VisibilityPolicy.visibleProjects(all, "dashboard", showAll).map((p) => p.id)).not.toContain("done");
    expect(VisibilityPolicy.visibleProjects(all, "dashboard", showAll, new Set(["done"])).map((p) => p.id)).toContain("done");
    const gone = Factory.project({ id: "gone", status: "Cancelled", nextMilestone: null });
    for (const ctx of ["dashboard", "report"] as const) {
      expect(VisibilityPolicy.isVisible(gone, ctx, ViewSettings.normalize(ctx, { hiddenStatuses: [] }), new Set(["gone"]))).toBe(false);
    }
    // Still openable (History) from the Cancelled and Completed pages, unless deleted or hidden from the dashboard.
    expect(VisibilityPolicy.isViewable(gone, ViewSettings.defaults("dashboard"))).toBe(true);
    expect(VisibilityPolicy.isViewable(done, ViewSettings.defaults("dashboard"))).toBe(true);
    expect(VisibilityPolicy.isViewable({ ...gone, hiddenFromDashboard: true }, ViewSettings.defaults("dashboard"))).toBe(false);
    expect(VisibilityPolicy.isViewable({ ...done, archivedAt: new Date() }, ViewSettings.defaults("dashboard"))).toBe(false);
  });

  it("filters history for non-admins: only visible projects, never hide/delete events", () => {
    const history = [
      { projectId: "live", field: "note" },
      { projectId: "live", field: "hiddenFromReport" },
      { projectId: "live", field: "archivedAt" },
      { projectId: "live", field: "deletedBy" },
      { projectId: "live", field: "hiddenFromDashboard" },
      { projectId: "deleted", field: "note" },
    ];
    expect(VisibilityPolicy.historyFor(Factory.MEMBER, history, ["live"])).toEqual([{ projectId: "live", field: "note" }]);
    expect(VisibilityPolicy.historyFor(Factory.ADMIN, history, ["live"])).toHaveLength(6);
    expect(VisibilityPolicy.publicHistoryWhere().field.notIn).toEqual([...VisibilityPolicy.ADMIN_ONLY_HISTORY_FIELDS]);
  });

  it("strips the frozen view settings from snapshots for non-admins", () => {
    const snap = { id: "s", rowsJson: [], viewSettingsJson: { hiddenStatuses: [] } };
    expect(VisibilityPolicy.snapshotForViewer(snap, Factory.MEMBER)).toEqual({ id: "s", rowsJson: [] });
    expect(VisibilityPolicy.snapshotForViewer(snap, Factory.ADMIN)).toBe(snap);
  });
});
