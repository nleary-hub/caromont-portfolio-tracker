import { describe, expect, it } from "vitest";
import { PortfolioContext } from "@/lib/ai/context/PortfolioContext";
import { PortfolioSignals } from "@/lib/ai/context/PortfolioSignals";
import { AiToolsService } from "@/lib/services/AiToolsService";
import { PortfolioContextService } from "@/lib/services/PortfolioContextService";
import { ADMIN as ADMIN_T, ENV, MockProvider, SCOPE, toolsSetup } from "./helpers/aiTools";
import { CONTRACTS, GOLDEN, MirrorDb, NOW, P, PEOPLE, PROJECTS, REQUESTERS, TODAY, scope } from "./fixtures/portfolio-mirror";

// Item A: buildPortfolioContext over the fictional 33-project mirror. Example data only.
const ADMIN = { email: "director@example.org", isAdmin: true };

async function load() {
  const db = new MirrorDb();
  const sc = scope();
  const projects = await AiToolsService.projects(db as never, sc);
  const built = await PortfolioContextService.build({ db, scope: sc, viewer: ADMIN, projects, now: NOW });
  const lines = built.projects.split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  const byName = new Map(lines.map((l) => [l.name as string, l]));
  const ctx = new Map(built.input.projects.map((p) => [p.name, p]));
  return { db, projects, built, lines, byName, ctx };
}

/** Signals worked out independently from the fixture (not through PortfolioSignals). */
function oracle(p: (typeof PROJECTS)[number]) {
  const open = p.status !== "Complete" && p.status !== "Cancelled";
  const next = p.steps.find((x) => !x.done) ?? null;
  const due = next?.due ?? null;
  const overdue = open && !!due && due < TODAY;
  let noChange = 0;
  for (const r of p.reports) if (!r.changed) noChange++;
  else break;
  return { overdue, unassignedOwner: open && !p.owner, noChange };
}

describe("PortfolioContext (item A, fictional mirror)", () => {
  it("lists all 33 projects with refs in list order", async () => {
    const { projects, lines } = await load();
    expect(PROJECTS).toHaveLength(33);
    expect(lines).toHaveLength(33);
    lines.forEach((l, i) => {
      expect(l.ref).toBe(`P${i + 1}`);
      expect(l.name).toBe(projects[i].name);
    });
  });

  it("computed signals match the independently computed truth for every project", async () => {
    const { ctx } = await load();
    for (const p of PROJECTS) {
      const c = ctx.get(p.name)!;
      const o = oracle(p);
      expect({ name: p.name, overdue: c.signals.overdue, unassignedOwner: c.signals.unassignedOwner, noChange: c.signals.noChangeReports }).toEqual({ name: p.name, overdue: o.overdue, unassignedOwner: o.unassignedOwner, noChange: o.noChange });
    }
    const overdue = PROJECTS.filter((p) => ctx.get(p.name)!.signals.overdue).map((p) => p.i).sort((a, b) => a - b);
    expect(overdue).toEqual([GOLDEN.LUMEN_REBATE, GOLDEN.DOWNTIME, GOLDEN.CORTEX_EEG, GOLDEN.SUITE_BUILD]);
  });

  it("golden twin: the Off track unowned project with repeated No change is flagged in words", async () => {
    const { byName } = await load();
    const r = byName.get("Relocate APP clinic from IR Suite B")!;
    expect(r.owner).toBe("To assign");
    expect(r.status).toBe("Off track");
    expect(r.flags).toEqual(expect.arrayContaining(["no owner assigned", '"No change" 2 reports in a row', "Off track or At risk 2 reports in a row", "current milestone has no owner"]));
    expect((r.flags as string[]).some((f) => f.startsWith("stale"))).toBe(true);
  });

  it("golden twin: the Off track supply project blocks two projects, both directions, with the note and days", async () => {
    const { byName, ctx } = await load();
    expect(byName.get("Northwind Stent Supply")!.blocking).toEqual(["Northwind Stent Rebate", "Northwind Stent Consignment"]);
    expect(byName.get("Northwind Stent Rebate")!.blockedBy).toEqual([{ project: "Northwind Stent Supply", status: "Off track", waitingOn: "Supply agreement", since: "2026-09-20", daysBlocked: 27 }]);
    expect(ctx.get("Northwind Stent Rebate")!.blockerFlags).toEqual(["On track, but its blocker is Off track"]);
  });

  it("external blockers carry who, what, days and the follow-up; an overdue follow-up is flagged", async () => {
    const { byName } = await load();
    const c = byName.get("Cortex EEG Upgrade")!;
    expect(c.externalBlockers).toEqual([{ waitingOn: "Cortex Medical", what: "Vendor redlines", since: "2026-10-08", daysBlocked: 9, followUpOn: "2026-10-15", followUpOwner: "Taylor Quinn" }]);
    expect((c.flags as string[]).some((f) => f.startsWith("Follow-up overdue"))).toBe(true);
  });

  it("milestones are the full ordered list with owner, due and done, plus N of M and the current owner", async () => {
    const { byName } = await load();
    const ep = byName.get("EP Lab 2 Build-out")!;
    expect(ep.milestoneProgress).toBe("1 of 4");
    expect(ep.nextMilestone).toBe("Drywall");
    expect(ep.milestoneOwner).toBe("Quinn Harlow");
    expect(ep.milestones).toEqual([
      { name: "Demolition", done: true, owner: "Quinn Harlow", due: "2026-09-01" },
      { name: "Drywall", done: false, owner: "Quinn Harlow", due: "2026-10-15" },
      { name: "Flooring and ceiling", done: false, due: "2026-10-29" },
      { name: "Equipment install", done: false, due: "2026-12-01" },
    ]);
  });

  it("full Latest update (no 300 cap), prior updates with dates, REQ number, department, status since", async () => {
    const { byName } = await load();
    const s = byName.get("Northwind Stent Supply")!;
    expect(s.req).toBe("REQ-5101");
    expect(s.department).toBe("Interventional Radiology");
    expect(s.priorUpdates).toEqual([{ on: "2026-10-01", text: "Pricing review done; agreement sent to vendor." }]);
    expect(s.statusSince).toBe("2026-09-20");
    expect(s.daysInStatus).toBe(27);
    expect(s.contractsLead).toBe("Jordan Pike");
  });

  it("header: today, service line, user and role, and the glossary (terms without definitions say so)", async () => {
    const { built } = await load();
    expect(built.header).toContain(`Today: ${TODAY}`);
    expect(built.header).toContain("User: Example Director, Director of an example service line");
    expect(built.header).toContain("- SIVAT (no definition yet)");
    expect(built.header).toContain("- MFI: Major Facility Investment");
    expect(built.text).not.toContain("\u2014");
  });

  it("names only people from the line's lists (or To assign / Not applicable): nothing invented", async () => {
    const { lines } = await load();
    const allowed = new Set([...PEOPLE, ...REQUESTERS, ...CONTRACTS, "To assign", "Not applicable"]);
    for (const l of lines) {
      for (const k of ["owner", "requester", "contractsLead", "milestoneOwner"]) if (l[k] !== undefined) expect(allowed.has(l[k] as string)).toBe(true);
      for (const m of (l.milestones as { owner?: string }[] | undefined) ?? []) if (m.owner) expect(allowed.has(m.owner)).toBe(true);
    }
  });

  it("token budget: cuts oldest history first, then descriptions and done steps, and keeps refs stable", async () => {
    const { built } = await load();
    const full = built.tokens;
    const small = PortfolioContext.build(built.input, Math.floor(full * 0.97));
    expect(small.cuts[0]).toBe("prior updates cut to 2");
    expect(small.tokens).toBeLessThanOrEqual(Math.floor(full * 0.97));
    const tiny = PortfolioContext.build(built.input, 1500);
    expect(tiny.cuts).toEqual(expect.arrayContaining(["prior updates cut to 0", "descriptions shortened", "done milestones left out", "closed projects with no blockers left out"]));
    expect(tiny.omitted.length).toBeGreaterThan(0);
    const first = JSON.parse(tiny.projects.split("\n")[0]);
    expect(first.ref).toBe("P1");
  });

  it("PortfolioSignals: due within 14 days, status/date mismatch, streak words", () => {
    const base = { owner: "Avery Lin", hasOpenStep: true, nextStepOwner: "Avery Lin", statusSince: "2026-10-01", reports: [] };
    expect(PortfolioSignals.compute({ ...base, status: "OnTrack", dueDate: "2026-10-31", updatedOn: TODAY }, TODAY).dueWithin14Days).toBe(true);
    expect(PortfolioSignals.compute({ ...base, status: "OnTrack", dueDate: "2026-11-01", updatedOn: TODAY }, TODAY).dueWithin14Days).toBe(false);
    const late = PortfolioSignals.compute({ ...base, status: "OnTrack", dueDate: "2026-10-10", updatedOn: TODAY }, TODAY);
    expect(late.statusDateMismatch).toBe(true);
    expect(PortfolioSignals.words(late)).toContain("status says on track but it is past due");
    const done = PortfolioSignals.compute({ ...base, owner: null, status: "Complete", dueDate: "2026-10-10", updatedOn: "2026-01-01" }, TODAY);
    expect(PortfolioSignals.words(done)).toEqual([]);
  });

  it("the AI tools prompt carries the shared context, not the old 5-field list (meeting notes, via the provider body)", async () => {
    const db = await toolsSetup();
    const p = new MockProvider('{"changes":[]}');
    const r = await AiToolsService.proposeChanges({ db, viewer: ADMIN_T, scope: SCOPE, feature: "meeting_notes", input: "Example Clinic refresh on hold.", env: ENV, fetchImpl: p.fetch });
    expect(r.ok).toBe(true);
    const body = JSON.stringify(JSON.parse(p.calls[0]));
    expect(body).toContain("Portfolio context:");
    expect(body).toContain("Today: ");
    expect(body).toContain('\\"owner\\":\\"To assign\\"');
    expect(body).toContain("Never invent a name, date or number");
    expect(P(1)).toMatch(/^70000000/);
  });
});
