import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DashboardQuery } from "@/lib/dashboard/DashboardQuery";
import { DashboardPrefs } from "@/lib/dashboard/DashboardPrefs";
import { BlockerSignals, type RowBlockers } from "@/lib/projects/BlockerSignals";
import { BlockerSummaryService } from "@/lib/services/BlockerSummaryService";

// 1b dashboard signals. Fictional names only.
const TODAY = "2026-10-17";
const proj = (x: Partial<RowBlockers["blockedBy"][number]> = {}): RowBlockers["blockedBy"][number] => ({ id: "p1", name: "Imaging Scheduler Upgrade", status: "OnTrack", dueDate: null, since: "2026-10-02", prompt: false, ...x });
const ext = (x: Partial<RowBlockers["external"][number]> = {}): RowBlockers["external"][number] => ({ waitingOn: "Northbeam Interiors", description: "Kiosk enclosure quote", since: "2026-10-05", followUpOn: null, ...x });
const B = (x: Partial<RowBlockers> = {}): RowBlockers => ({ blockedBy: [], external: [], blocking: 0, ...x });
const S = BlockerSignals;

describe("BlockerSignals: pills", () => {
  it("Waiting on: most recent open item's name, days since the earliest", () => {
    const b = B({ blockedBy: [proj()], external: [ext()] });
    expect(S.pillText(b, TODAY)).toBe("Waiting on Northbeam Interiors · 15 days");
    expect(S.daysBlocked(b, TODAY)).toBe(15);
    expect(S.pillText(B({ blockedBy: [proj({ since: "2026-10-16" })] }), TODAY)).toBe("Waiting on Imaging Scheduler Upgrade · 1 day");
    expect(S.pillText(B({ blockedBy: [proj({ since: TODAY })] }), TODAY)).toBe("Waiting on Imaging Scheduler Upgrade · 0 days");
  });

  it("ties on the same day pick the project, then A to Z, so the pill is stable", () => {
    expect(S.latestName(B({ blockedBy: [proj({ since: "2026-10-05", name: "Zeta Example" })], external: [ext()] }))).toBe("Zeta Example");
    expect(S.latestName(B({ external: [ext({ waitingOn: "Bravo Vendor" }), ext({ waitingOn: "Alpha Vendor" })] }))).toBe("Alpha Vendor");
  });

  it("nothing open: no Waiting on pill; Blocking N only when it blocks others", () => {
    expect(S.pillText(B({ blocking: 2 }), TODAY)).toBeNull();
    expect(S.blockingText(B({ blocking: 2 }))).toBe("Blocking 2");
    expect(S.blockingText(B())).toBeNull();
    expect(S.pillText(undefined, TODAY)).toBeNull();
    expect(S.isBlocked(B({ blocking: 3 }))).toBe(false);
  });

  it("tooltip lists every open item; prompts come only from Complete blockers flagged prompt", () => {
    const b = B({ blockedBy: [proj({ status: "Complete", prompt: true }), proj({ id: "p2", name: "Pharmacy Carousel Install", status: "OffTrack", since: "2026-10-09" })], external: [ext()] });
    expect(S.pillTooltip(b, TODAY).split("\n")).toEqual(["Waiting on:", "Imaging Scheduler Upgrade (project, Complete) since Oct 2", "Pharmacy Carousel Install (project, Off track) since Oct 9", "Northbeam Interiors: Kiosk enclosure quote since Oct 5"]);
    expect(S.prompts(b).map((p) => p.id)).toEqual(["p1"]);
    expect(S.promptText("Imaging Scheduler Upgrade")).toBe("Imaging Scheduler Upgrade is Complete. Clear it?");
  });

  it("KPI: overdue follow-ups (past today only) and the plain sub-line", () => {
    const b = B({ external: [ext({ followUpOn: "2026-10-15" }), ext({ followUpOn: TODAY }), ext({ followUpOn: "2026-10-20" })] });
    expect(S.overdueFollowUps(b, TODAY)).toBe(1);
    expect(S.overdueLine(0)).toBeNull();
    expect(S.overdueLine(1)).toBe("1 follow-up overdue");
    expect(S.overdueLine(3)).toBe("3 follow-ups overdue");
  });
});

describe("BlockerSignals: the five flags (words only)", () => {
  it("each flag in the spec's words, in a fixed order", () => {
    const b = B({
      blockedBy: [proj({ status: "OffTrack", dueDate: "2026-11-18", since: "2026-09-10" }), proj({ id: "p3", name: "Cancelled Example", status: "Cancelled", since: "2026-10-01" })],
      external: [ext({ followUpOn: "2026-10-15" })],
    });
    expect(S.flags({ status: "OnTrack", dueDate: "2026-11-04" }, b, TODAY).map((f) => f.text)).toEqual([
      "Due Nov 4, before its blocker (due Nov 18)",
      "On track, but its blocker is Off track",
      "Follow-up overdue since Oct 15",
      "Blocker was Cancelled",
      "Blocked for 30+ days",
    ]);
    expect(S.flagsText(S.flags({ status: "OnTrack", dueDate: "2026-11-04" }, b, TODAY))).toContain("\n");
  });

  it("On hold blocker wording; a Complete or Cancelled blocker does not count for the due date or trouble flags", () => {
    expect(S.flags({ status: "OnTrack", dueDate: null }, B({ blockedBy: [proj({ status: "OnHold" })] }), TODAY).map((f) => f.kind)).toEqual(["blockerTrouble"]);
    expect(S.flags({ status: "OnTrack", dueDate: null }, B({ blockedBy: [proj({ status: "OnHold" })] }), TODAY)[0].text).toBe("On track, but its blocker is On hold");
    expect(S.flags({ status: "OnTrack", dueDate: "2026-11-01" }, B({ blockedBy: [proj({ status: "Complete", dueDate: "2026-12-01" })] }), TODAY)).toEqual([]);
  });

  it("no flags when the row is closed, not blocked, or only At risk with an Off track blocker", () => {
    const b = B({ blockedBy: [proj({ status: "OffTrack", since: "2026-08-01" })] });
    expect(S.flags({ status: "Complete", dueDate: null }, b, TODAY)).toEqual([]);
    expect(S.flags({ status: "Cancelled", dueDate: null }, b, TODAY)).toEqual([]);
    expect(S.flags({ status: "OnTrack", dueDate: null }, B({ blocking: 3 }), TODAY)).toEqual([]);
    expect(S.flags({ status: "AtRisk", dueDate: null }, B({ blockedBy: [proj({ status: "OffTrack" })] }), TODAY)).toEqual([]);
  });

  it("29 days is not long; 30 is", () => {
    expect(S.flags({ status: "AtRisk", dueDate: null }, B({ external: [ext({ since: "2026-09-18" })] }), TODAY)).toEqual([]);
    expect(S.flags({ status: "AtRisk", dueDate: null }, B({ external: [ext({ since: "2026-09-17" })] }), TODAY).map((f) => f.kind)).toEqual(["blockedLong"]);
  });

  it("copy has no em dashes", () => {
    const src = readFileSync(path.resolve(__dirname, "../src/lib/projects/BlockerSignals.ts"), "utf8");
    expect(src).not.toContain("\u2014");
  });
});

describe("Dashboard: Blocked filter and tile (report untouched)", () => {
  const row = (id: string, blockers?: RowBlockers) => ({ id, name: id, blockers }) as never;
  it("the Blocked filter keeps rows with an open blocker or dependency, and counts as a filter", () => {
    const q = { ...DashboardQuery.empty(), blocked: true };
    expect(DashboardQuery.isFiltered(q)).toBe(true);
    expect(DashboardQuery.isFiltered(DashboardQuery.empty())).toBe(false);
    const rows = [row("a", B({ external: [ext()] })), row("b", B({ blocking: 2 })), row("c")];
    expect(rows.filter((r) => DashboardQuery.matchesFilters(r, q, TODAY)).map((r: { id: string }) => r.id)).toEqual(["a"]);
  });

  it("the Blocked tile is offered only when blocker data loaded, after the status and FY tiles", () => {
    expect(DashboardPrefs.availableTiles(true)).not.toContain("blocked");
    expect(DashboardPrefs.availableTiles(true, true).at(-1)).toBe("blocked");
    expect(DashboardPrefs.tileLabel("blocked", null)).toBe("Blocked");
  });

  it("the report path never reads the dashboard blocker summary", () => {
    for (const f of ["src/lib/report/ReportDataLoader.ts", "src/lib/services/SnapshotService.ts", "src/lib/services/FreezeService.ts"]) {
      const src = readFileSync(path.resolve(__dirname, "..", f), "utf8");
      expect(src).not.toMatch(/BlockerSummaryService|BlockerSignals|dependencyPromptDismissal/);
    }
  });
});

describe("BlockerSummaryService.forDashboard (in memory)", () => {
  const P = [
    { id: "a", name: "Alpha Example", status: "AtRisk" as const, dueDate: "2026-11-04" },
    { id: "b", name: "Bravo Example", status: "Complete" as const, dueDate: null },
    { id: "c", name: "Charlie Example", status: "OffTrack" as const, dueDate: new Date("2026-12-02T00:00:00Z") },
  ];
  const created = new Date("2026-10-02T15:00:00Z");
  const db = (dismissed: { dependencyId: string; dependencyCreatedAt: Date }[] = []) => {
    const calls: unknown[] = [];
    return {
      calls,
      projectDependency: {
        findMany: async (a: unknown) => (calls.push(a), [
          { id: "e1", projectId: "a", blockedById: "b", createdAt: created },
          { id: "e2", projectId: "a", blockedById: "c", createdAt: new Date("2026-10-09T15:00:00Z") },
          // Hidden project (another department): never named or counted.
          { id: "e3", projectId: "a", blockedById: "hidden", createdAt: created },
          { id: "e4", projectId: "hidden", blockedById: "c", createdAt: created },
        ]),
      },
      projectBlocker: { findMany: async () => [{ projectId: "a", waitingOn: "Northbeam Interiors", description: "Quote", since: new Date("2026-10-03T00:00:00Z"), followUpOn: new Date("2026-10-15T00:00:00Z") }] },
      dependencyPromptDismissal: { findMany: async (a: unknown) => (calls.push(a), dismissed) },
    };
  };

  it("names and counts only visible projects; open items only; prompt for a Complete blocker", async () => {
    const d = db();
    const out = await BlockerSummaryService.forDashboard(d as never, "line-1", " Viewer@Example.org ", P);
    expect(out.a.blockedBy).toEqual([
      { id: "b", name: "Bravo Example", status: "Complete", dueDate: null, since: "2026-10-02", prompt: true },
      { id: "c", name: "Charlie Example", status: "OffTrack", dueDate: "2026-12-02", since: "2026-10-09", prompt: false },
    ]);
    expect(out.a.external).toEqual([{ waitingOn: "Northbeam Interiors", description: "Quote", since: "2026-10-03", followUpOn: "2026-10-15" }]);
    expect(out.b.blocking).toBe(1);
    expect(out.c.blocking).toBe(1);
    expect(JSON.stringify(out)).not.toContain("hidden");
    expect(d.calls[0]).toMatchObject({ where: { serviceLineId: "line-1", removedAt: null } });
    expect(d.calls[1]).toMatchObject({ where: { email: "viewer@example.org" } });
  });

  it("a dismissal for the same createdAt hides the prompt; an older one (pair re-added) does not", async () => {
    expect((await BlockerSummaryService.forDashboard(db([{ dependencyId: "e1", dependencyCreatedAt: created }]) as never, "l", "v@example.org", P)).a.blockedBy[0].prompt).toBe(false);
    expect((await BlockerSummaryService.forDashboard(db([{ dependencyId: "e1", dependencyCreatedAt: new Date("2026-09-01T00:00:00Z") }]) as never, "l", "v@example.org", P)).a.blockedBy[0].prompt).toBe(true);
  });

  it("no projects: nothing is read", async () => {
    expect(await BlockerSummaryService.forDashboard({} as never, "l", "v@example.org", [])).toEqual({});
  });
});
