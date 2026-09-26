import { describe, expect, it } from "vitest";
import type { MissingChampion, ReportRow } from "@/lib/domain/types";
import { ProjectService } from "@/lib/services/ProjectService";
import { SnapshotService } from "@/lib/services/SnapshotService";
import { FakeDb } from "./helpers/FakeDb";

const actor = { changedBy: "nick.leary@example.org" };
const base = { serviceArea: "Cath", owner: "Owner A", status: "OnTrack", nextMilestone: "M1" };

describe("SnapshotService.create", () => {
  it("freezes rows, stores missing champions, and marks closed projects reported once", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    await ProjectService.create({ ...base, name: "Active", physicianChampion: "Dr. Missing" }, actor, db);
    const done = await ProjectService.create({ ...base, name: "Done", status: "Complete", nextMilestone: null }, actor, db);
    fake.state.recipients.push({ id: "r1", name: "Dr. Present", email: "p@x.org", active: true });

    const s1 = await SnapshotService.create(
      { periodStart: "2026-09-23", periodEnd: "2026-10-07", generatedBy: "nick", now: new Date("2026-10-07T10:00:00Z") },
      db,
    );
    const rows1 = s1.rowsJson as unknown as ReportRow[];
    expect(rows1.map((r) => r.name)).toEqual(["Active", "Done"]);
    expect(rows1.every((r) => r.changed)).toBe(true);
    expect((s1.missingChampionsJson as unknown as MissingChampion[]).map((m) => m.name)).toEqual(["Dr. Missing"]);
    expect(fake.state.projects.find((p) => p.id === done.id)?.closedReportedAt).toEqual(new Date("2026-10-07T10:00:00Z"));
    expect(fake.state.history.at(-1)).toMatchObject({ projectId: done.id, field: "closedReportedAt" });
    expect(fake.state.recipients).toHaveLength(1); // never auto-adds recipients

    const s2 = await SnapshotService.create(
      { periodStart: "2026-10-07", periodEnd: "2026-10-21", generatedBy: "nick", now: new Date("2026-10-21T10:00:00Z") },
      db,
    );
    const rows2 = s2.rowsJson as unknown as ReportRow[];
    expect(rows2.map((r) => r.name)).toEqual(["Active"]);
    expect(rows2[0].changed).toBe(false);
    expect(s2.pdfStorageKey).toBeNull(); // PDF renderer is a stub
  });
});
