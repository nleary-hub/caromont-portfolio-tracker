import { afterEach, describe, expect, it, vi } from "vitest";
import { DateOnly } from "@/lib/domain/DateOnly";
import type { MilestoneDraft } from "@/lib/domain/MilestoneRules";
import { ServiceLine } from "@/lib/domain/ServiceLine";
import { FreezeService, type FreezeOptions } from "@/lib/services/FreezeService";
import { ProjectService } from "@/lib/services/ProjectService";
import { FakeDb } from "./helpers/FakeDb";
import { Factory } from "./helpers/factories";

/**
 * Frank's test for Nick's completion rule (task 5, Oct 4, 2026): the last milestone closes on Sep 24 (automatic
 * completion), the date is then edited by hand, a milestone is added (reopen), and that milestone is deleted (the
 * manual date comes back). The Oct 13 report lists the project as Changed and completed; the Sep 29 artifacts and
 * handoff.json stay byte-identical.
 */
const ENV = { SHARE_LINK_SECRET: "x".repeat(48), APP_BASE_URL: "https://tracker.example.org/", REPORT_RECIPIENT_EMAIL: "you@example.org" };
const opts = (now: Date): FreezeOptions => ({ trigger: "cron", actor: "cron", env: ENV, now, fetch: vi.fn() });
const scope = () => ServiceLine.defaultScope();

afterEach(() => vi.useRealTimers());

describe("Frank: auto complete, manual edit, reopen, delete (restore) across two freezes", () => {
  it("Oct 13: Changed and completed; Sep 29 PDF and handoff.json byte-identical", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    const at = (iso: string) => vi.setSystemTime(new Date(iso));
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-09-15T14:00:00Z") });
    const steps = (id: string): MilestoneDraft[] =>
      fake.state.milestones
        .filter((m) => m.projectId === id)
        .sort((a, b) => (a.position as number) - (b.position as number))
        .map((s) => ({ id: s.id as string, name: s.name as string, dueDate: DateOnly.fromDbDate(s.dueDate as Date | null) ?? "", done: s.done as boolean, sourceTemplateId: null }));
    const save = (id: string, drafts: MilestoneDraft[]) => ProjectService.saveMilestones(id, { drafts }, Factory.ADMIN, db, scope());
    const project = (id: string) => fake.state.projects.find((p) => p.id === id)!;

    const p = await ProjectService.create({ name: "Closure device", serviceArea: "Cath", status: "OnTrack", nextMilestone: "Quote" }, { changedBy: "owner@example.org" }, db);
    await ProjectService.create({ name: "Steady project", serviceArea: "Cath", status: "OnTrack", nextMilestone: "Kickoff" }, { changedBy: "owner@example.org" }, db);
    await save(p.id, [
      { id: null, name: "Quote", dueDate: "", done: false, sourceTemplateId: null },
      { id: null, name: "Contract", dueDate: "", done: false, sourceTemplateId: null },
    ]);

    // Sep 24: the last milestone closes. Automatic completion.
    at("2026-09-24T15:00:00Z");
    await save(p.id, steps(p.id).map((d) => ({ ...d, done: true })));
    expect(project(p.id).status).toBe("Complete");
    expect(DateOnly.fromDbDate(project(p.id).completedAtAuto as Date)).toBe("2026-09-24");

    // Sep 29 freeze.
    const sep29 = await FreezeService.run(opts(new Date("2026-09-29T21:01:00Z")), db);
    expect(sep29.outcome).toBe("created");
    const copy = () => fake.state.artifacts.filter((a) => a.snapshotId === sep29.snapshotId).map((a) => [a.kind, Buffer.from(a.bytes as Uint8Array).toString("base64")]);
    const sep29Artifacts = copy();
    expect(sep29Artifacts.map(([k]) => k).sort()).toEqual(["handoff", "pdf"]);
    const sep29Snapshot = JSON.stringify(fake.state.snapshots.find((x) => x.id === sep29.snapshotId));

    // Oct 1: the date is edited by hand. Oct 2: a milestone is added (reopen). Oct 5: that milestone is deleted.
    at("2026-10-01T15:00:00Z");
    await ProjectService.saveForm(p.id, { completedOn: "2026-09-23" }, Factory.ADMIN, db);
    at("2026-10-02T15:00:00Z");
    await save(p.id, [...steps(p.id), { id: null, name: "Training", dueDate: "", done: false, sourceTemplateId: null }]);
    expect(project(p.id).status).toBe("OnTrack");
    at("2026-10-05T15:00:00Z");
    await save(p.id, steps(p.id).filter((d) => d.name !== "Training"));
    expect(project(p.id).status).toBe("Complete");
    expect(DateOnly.fromDbDate(project(p.id).completedOn as Date)).toBe("2026-09-23");
    expect(fake.state.history.filter((h) => h.projectId === p.id && h.field === "completion").map((h) => h.comment)).toEqual([
      "completion:auto",
      "completion:manual",
      "completion:reopened_added",
      "completion:restored",
    ]);

    // Oct 13 freeze: Changed and listed as completed in the period.
    const oct13 = await FreezeService.run(opts(new Date("2026-10-13T21:01:00Z")), db);
    expect(oct13.outcome).toBe("created");
    const snap = fake.state.snapshots.find((x) => x.id === oct13.snapshotId)!;
    const rows = snap.rowsJson as { projectId: string; status: string; changed: boolean; completedInPeriod?: boolean }[];
    const row = rows.find((r) => r.projectId === p.id)!;
    expect(row).toMatchObject({ status: "Complete", changed: true });
    expect(row.completedInPeriod).toBe(true);
    const handoff = JSON.parse(Buffer.from(fake.state.artifacts.find((a) => a.snapshotId === oct13.snapshotId && a.kind === "handoff")!.bytes as Uint8Array).toString("utf8"));
    expect(JSON.stringify(handoff)).toContain("Closure device");

    // Sep 29: PDF, handoff.json and the snapshot row are byte-identical; a re-run of that period renders nothing.
    expect(copy()).toEqual(sep29Artifacts);
    expect(JSON.stringify(fake.state.snapshots.find((x) => x.id === sep29.snapshotId))).toBe(sep29Snapshot);
  });
});
