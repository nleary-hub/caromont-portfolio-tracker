import { describe, expect, it } from "vitest";
import { AdminAuditService } from "@/lib/services/AdminAuditService";
import { ProjectHistoryService } from "@/lib/services/ProjectHistoryService";
import { ProjectService } from "@/lib/services/ProjectService";
import { ViewSettingsService } from "@/lib/services/ViewSettingsService";
import { ViewSettings } from "@/lib/domain/ViewSettings";
import { Factory } from "./helpers/factories";
import { FakeDb } from "./helpers/FakeDb";

const actor = { changedBy: "editor@example.org" };
const base = { serviceArea: "Cath", owner: "Owner A", status: "OnTrack", nextMilestone: "M1" };

class NextErrors {
  /** next/navigation notFound() throws an error whose digest marks a 404. */
  static isNotFound(e: unknown): boolean {
    const digest = (e as { digest?: string })?.digest ?? "";
    return digest.includes("404");
  }
}

describe("AdminAuditService (/admin/audit)", () => {
  it("returns 404 (notFound, not 403) for non-admins and anonymous viewers", async () => {
    const fake = new FakeDb();
    for (const viewer of [Factory.MEMBER, null]) {
      let caught: unknown = null;
      try {
        await AdminAuditService.load(viewer, fake.asClient());
      } catch (e) {
        caught = e;
      }
      expect(NextErrors.isNotFound(caught)).toBe(true);
    }
  });

  it("lists hidden and deleted projects and who/when for admins; restore and unhide write audit rows", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    const a = await ProjectService.create({ ...base, name: "Alpha" }, actor, db);
    const b = await ProjectService.create({ ...base, name: "Bravo" }, actor, db);
    await ProjectService.create({ ...base, name: "Charlie" }, actor, db);
    await ProjectService.setHidden(a.id, "report", true, Factory.ADMIN, db);
    await ProjectService.softDelete(b.id, Factory.ADMIN, db);
    await ViewSettingsService.update("dashboard", ViewSettings.normalize("dashboard", { hiddenStatuses: [] }), { changedBy: Factory.ADMIN.email }, db);

    const data = await AdminAuditService.load(Factory.ADMIN, db);
    expect(data.hidden.map((p) => [p.name, p.hiddenFromDashboard, p.hiddenFromReport])).toEqual([["Alpha", false, true]]);
    expect(data.deleted.map((p) => [p.name, p.deletedBy])).toEqual([["Bravo", Factory.ADMIN.email]]);
    expect(data.deleted[0].deletedAt).toBeInstanceOf(Date);
    const fields = data.events.map((e) => [e.subject, e.field, e.by]);
    expect(fields).toEqual(
      expect.arrayContaining([
        ["Alpha", "hiddenFromReport", Factory.ADMIN.email],
        ["Bravo", "archivedAt", Factory.ADMIN.email],
        ["Bravo", "deletedBy", Factory.ADMIN.email],
        ["dashboard", "viewSettings", Factory.ADMIN.email],
      ]),
    );
    // Only admin-only events; ordinary edits are not audit noise.
    expect(data.events.some((e) => e.field === "created" || e.field === "note")).toBe(false);

    await ProjectService.restore(b.id, Factory.ADMIN, db);
    await ProjectService.setHidden(a.id, "report", false, Factory.ADMIN, db);
    const after = await AdminAuditService.load(Factory.ADMIN, db);
    expect(after.hidden).toEqual([]);
    expect(after.deleted).toEqual([]);
    expect(after.events.length).toBe(data.events.length + 3); // archivedAt, deletedBy, hiddenFromReport
  });
});

describe("ProjectHistoryService.forProject", () => {
  it("filters history for non-admins and shows everything to admins", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    const p = await ProjectService.create({ ...base, name: "Alpha" }, actor, db);
    await ProjectService.update(p.id, { note: "hello" }, actor, db);
    await ProjectService.setHidden(p.id, "report", true, Factory.ADMIN, db);

    const member = await ProjectHistoryService.forProject(p.id, Factory.MEMBER, db);
    expect(member.map((h) => h.field).sort()).toEqual(["created", "note"]);
    const admin = await ProjectHistoryService.forProject(p.id, Factory.ADMIN, db);
    expect(admin.map((h) => h.field)).toContain("hiddenFromReport");

    // Hidden from the dashboard (or deleted): non-admins get no history at all.
    await ProjectService.setHidden(p.id, "dashboard", true, Factory.ADMIN, db);
    expect(await ProjectHistoryService.forProject(p.id, Factory.MEMBER, db)).toEqual([]);
    await ProjectService.setHidden(p.id, "dashboard", false, Factory.ADMIN, db);
    await ProjectService.softDelete(p.id, Factory.ADMIN, db);
    expect(await ProjectHistoryService.forProject(p.id, Factory.MEMBER, db)).toEqual([]);
    expect((await ProjectHistoryService.forProject(p.id, Factory.ADMIN, db)).length).toBeGreaterThan(0);
  });
});
