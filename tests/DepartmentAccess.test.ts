import { beforeEach, describe, expect, it } from "vitest";
import { AccessGridModel } from "@/lib/access/AccessGridModel";
import { DepartmentAccess } from "@/lib/access/DepartmentAccess";
import { DepartmentAccessCopy } from "@/lib/access/DepartmentAccessCopy";
import { LineAccessCopy } from "@/lib/access/LineAccessCopy";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { AdminRequiredError } from "@/lib/auth/AdminPolicy";
import { ServiceLine } from "@/lib/domain/ServiceLine";
import { AdminAuditService } from "@/lib/services/AdminAuditService";
import { DepartmentAccessService } from "@/lib/services/DepartmentAccessService";
import { DepartmentService } from "@/lib/services/DepartmentService";
import { LineAccessService, type AccessLine, type AccessRow } from "@/lib/services/LineAccessService";
import { ProjectService } from "@/lib/services/ProjectService";
import { ProjectHistoryService } from "@/lib/services/ProjectHistoryService";
import { FakeDb } from "./helpers/FakeDb";
import { Factory } from "./helpers/factories";

const ADMIN = Factory.ADMIN;
const JANE = "jane.doe@caromonthealth.org";
const ENV = { ALLOWED_EMAILS: "@caromonthealth.org @example.org", ADMIN_EMAILS: ADMIN.email };
const CVPSL = ServiceLine.DEFAULT_ID;
const AZ = ["CardioNeuro", "Cath Lab", "CVSS", "Echo", "EP Lab", "INU", "IR"];
const actor = { changedBy: "nick.leary@caromonthealth.org" };

let fake: FakeDb;
let db: never;

beforeEach(() => {
  fake = new FakeDb();
  db = fake.asClient() as never;
  fake.grant(JANE, CVPSL);
  fake.state.appUsers[0].name = "Jane Doe";
});

describe("Writing Bot copy", () => {
  it("cell, caret, switch, toasts, confirm, card and audit strings", () => {
    expect(DepartmentAccessCopy.countText(3, 7)).toBe("3 of 7");
    expect(DepartmentAccessCopy.limitedCellLabel("Jane Doe", "CVPSL", 3, 7)).toBe("Jane Doe, CVPSL access, 3 of 7 departments");
    expect([DepartmentAccessCopy.showDepartments("Jane Doe"), DepartmentAccessCopy.hideDepartments("Jane Doe")]).toEqual(["Show Jane Doe's departments", "Hide Jane Doe's departments"]);
    expect(LineAccessCopy.NOTE).toBe("Covers all service lines and departments. Admins can see everything.");
    expect(LineAccessCopy.ADD_HELPER).toBe("They'll see only the lines and departments you choose here.");
    expect([DepartmentAccessCopy.ALL_DEPARTMENTS, DepartmentAccessCopy.HELPER_ON, DepartmentAccessCopy.HELPER_OFF]).toEqual([
      "All departments",
      "Includes departments added later.",
      "Only the checked departments. New ones aren't added.",
    ]);
    expect(DepartmentAccessCopy.grantedToast("Jane Doe", "Echo", "CVPSL")).toBe("Jane Doe can now see Echo in CVPSL.");
    expect(DepartmentAccessCopy.revokedToast("Jane Doe", "Echo", "CVPSL")).toBe("Jane Doe can no longer see Echo in CVPSL.");
    expect(DepartmentAccessCopy.allOnToast("Jane Doe", "CVPSL")).toBe("Jane Doe can now see all CVPSL departments.");
    expect(DepartmentAccessCopy.allOffToast("Jane Doe", "CVPSL")).toBe("Jane Doe now sees only the checked CVPSL departments.");
    expect(DepartmentAccessCopy.SAVE_ERROR).toBe("Couldn't save access. Try again.");
    expect(DepartmentAccessCopy.removeLastTitle("Jane Doe", "CVPSL")).toBe("Remove Jane Doe's last CVPSL department?");
    expect(DepartmentAccessCopy.removeLastBody("CVPSL")).toBe("This also removes CVPSL. They won't see its projects until an admin adds it again.");
    expect(DepartmentAccessCopy.REMOVE_BUTTON).toBe("Remove access");
    expect([DepartmentAccessCopy.PROJECT_TITLE, DepartmentAccessCopy.PROJECT_BODY, DepartmentAccessCopy.GO_TO_DASHBOARD]).toEqual([
      "You don't have access to this project",
      "Ask an admin if you need it.",
      "Go to dashboard",
    ]);
    expect(DepartmentAccessCopy.movedAudit("Jane Doe", "Cath Lab", "Invasive Cardiology")).toBe("Jane Doe's Cath Lab access moved to Invasive Cardiology when Cath Lab was deleted.");
    // No em dashes anywhere in the new copy.
    const all = Object.values(DepartmentAccessCopy).filter((v) => typeof v === "string").join(" ");
    expect(all).not.toMatch(/\u2014/);
  });
});

describe("AccessGridModel: cells and the department panel", () => {
  const line: AccessLine = { id: "L", shortName: "CVPSL", name: "Cardio", departments: ["a", "b", "c", "d", "e", "f", "g"].map((id) => ({ id, name: id.toUpperCase() })) };
  const row: AccessRow = { email: "j@x.org", name: "Jane Doe", isAdmin: false, lineIds: ["L"], limits: {} };

  it("a checked line is unlimited (plain checkbox); limited shows granted of total open departments", () => {
    expect(AccessGridModel.count(row, line)).toBeNull();
    const limited = { ...row, limits: { L: ["a", "b", "c", "gone"] } };
    expect(AccessGridModel.count(limited, line)).toEqual({ granted: 3, total: 7 });
    expect(AccessGridModel.count({ ...limited, lineIds: [] }, line)).toBeNull();
    expect(AccessGridModel.count({ ...limited, isAdmin: true }, line)).toBeNull();
  });

  it("admins and people with no line don't expand", () => {
    expect(AccessGridModel.expandable(row)).toBe(true);
    expect(AccessGridModel.expandable({ ...row, isAdmin: true })).toBe(false);
    expect(AccessGridModel.expandable({ ...row, lineIds: [] })).toBe(false);
  });

  it("switch off checks every department at first; on clears the limit; unchecking the line drops it; re-checking gives All", () => {
    const off = AccessGridModel.setAll(row, line, false);
    expect(off.limits.L).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
    expect(line.departments.every((d) => AccessGridModel.hasDepartment(off, "L", d.id))).toBe(true);
    expect(AccessGridModel.setAll(off, line, true).limits).toEqual({});
    const unchecked = AccessGridModel.toggle(off, "L", false);
    expect(unchecked).toMatchObject({ lineIds: [], limits: {} });
    expect(AccessGridModel.isAll(AccessGridModel.toggle(unchecked, "L", true), "L")).toBe(true);
  });

  it("unchecking the last department asks first and then removes the line", () => {
    const one = { ...row, limits: { L: ["c"] } };
    expect(AccessGridModel.needsDepartmentConfirm(one, "L", "c", false)).toBe(true);
    expect(AccessGridModel.needsDepartmentConfirm(one, "L", "c", true)).toBe(false);
    expect(AccessGridModel.needsDepartmentConfirm({ ...row, limits: { L: ["b", "c"] } }, "L", "c", false)).toBe(false);
    expect(AccessGridModel.needsDepartmentConfirm(row, "L", "c", false)).toBe(false);
    expect(AccessGridModel.toggleDepartment(one, "L", "c", false)).toMatchObject({ lineIds: [], limits: {} });
    expect(AccessGridModel.toggleDepartment(one, "L", "a", true).limits.L).toEqual(["c", "a"]);
  });
});

describe("DepartmentAccess: the narrowed scope", () => {
  it("narrow keeps only granted departments (never deleted ones) and sets the project filter", async () => {
    const full = await ServiceLineAccess.defaultLine(db);
    expect(DepartmentAccess.narrow(full, null)).toBe(full);
    const n = DepartmentAccess.narrow(full, ["Echo", "Cath", "nope"]);
    expect(n.departments.map((d) => d.id)).toEqual(["Cath", "Echo"]);
    expect(n.departmentLimit).toEqual(["Cath", "Echo"]);
    expect(DepartmentAccess.projectWhere(n)).toEqual({ serviceLineId: CVPSL, departmentId: { in: ["Cath", "Echo"] } });
    expect(DepartmentAccess.projectWhere(full)).toEqual({ serviceLineId: CVPSL });
    expect([DepartmentAccess.allows(n, "Echo"), DepartmentAccess.allows(n, "EP"), DepartmentAccess.allows(n, null), DepartmentAccess.allows(full, null)]).toEqual([true, false, false, true]);
  });

  it("activeFor: All departments = the whole line; limited = their departments; admins are never limited", async () => {
    const viewer = { email: JANE, isAdmin: false };
    expect((await ServiceLineAccess.activeFor(viewer, db)).departmentLimit).toBeUndefined();
    fake.limit(JANE, CVPSL, "Echo", "IR");
    const s = await ServiceLineAccess.activeFor(viewer, db);
    expect(s.departments.map((d) => d.name)).toEqual(["Echo", "IR"]);
    expect(DepartmentAccess.isLimited(s)).toBe(true);
    // Someone else's limit doesn't touch an admin.
    fake.grant(ADMIN.email, CVPSL);
    fake.limit(ADMIN.email, CVPSL, "Echo");
    expect((await ServiceLineAccess.activeFor(ADMIN, db)).departmentLimit).toBeUndefined();
  });

  it("History of a project outside their departments is the same empty answer as a missing project", async () => {
    const p = await ProjectService.create({ serviceArea: "Cath", owner: "O", status: "OnTrack", nextMilestone: "M", name: "Cath secret" }, actor, db);
    fake.limit(JANE, CVPSL, "Echo");
    const scope = await ServiceLineAccess.activeFor({ email: JANE, isAdmin: false }, db);
    const t = await ProjectHistoryService.timeline(p.id, { email: JANE, isAdmin: false }, db, scope);
    expect(t).toEqual(await ProjectHistoryService.timeline("00000000-0000-4000-8000-00000000dead", { email: JANE, isAdmin: false }, db, scope));
    expect((await ProjectHistoryService.timeline(p.id, ADMIN, db, await ServiceLineAccess.activeFor(ADMIN, db))).entries.length).toBeGreaterThan(0);
  });
});

describe("DepartmentAccessService: the panel saves as you go (admin-only, logged)", () => {
  it("grid: each line's open departments A to Z; limits only for lines with All departments off", async () => {
    let g = await LineAccessService.grid(ADMIN, db, ENV);
    expect(g.lines[0].departments.map((d) => d.name)).toEqual(AZ);
    expect(g.users[0]).toMatchObject({ lineIds: [CVPSL], limits: {} });
    fake.limit(JANE, CVPSL, "Echo", "IR", "EP");
    g = await LineAccessService.grid(ADMIN, db, ENV);
    expect(g.users[0].limits).toEqual({ [CVPSL]: ["Echo", "EP", "IR"] });
    expect(AccessGridModel.count(g.users[0], g.lines[0])).toEqual({ granted: 3, total: 7 });
  });

  it("count rule: no count while All departments is on; 'N of 7' whenever it is off, even with every box checked", async () => {
    const cell = async () => {
      const g = await LineAccessService.grid(ADMIN, db, ENV);
      const model = AccessGridModel.count(g.users[0], g.lines[0]);
      return { model, text: model ? DepartmentAccessCopy.countText(model.granted, model.total) : null };
    };
    // On (the default): plain checkbox, no count.
    expect(await cell()).toEqual({ model: null, text: null });
    // Off: every department checked at first, and the count shows "7 of 7".
    await DepartmentAccessService.setAll(ADMIN, JANE, CVPSL, false, db, ENV);
    expect(await cell()).toEqual({ model: { granted: 7, total: 7 }, text: "7 of 7" });
    await DepartmentAccessService.setDepartment(ADMIN, JANE, CVPSL, "Cath", false, db, ENV);
    expect(await cell()).toEqual({ model: { granted: 6, total: 7 }, text: "6 of 7" });
    // Checking the last one again keeps the switch off: still a count.
    await DepartmentAccessService.setDepartment(ADMIN, JANE, CVPSL, "Cath", true, db, ENV);
    expect(await cell()).toEqual({ model: { granted: 7, total: 7 }, text: "7 of 7" });
    // Back on: no count.
    await DepartmentAccessService.setAll(ADMIN, JANE, CVPSL, true, db, ENV);
    expect(await cell()).toEqual({ model: null, text: null });
    // The model alone: switched off in the browser with every box checked.
    const line: AccessLine = { id: "L", shortName: "CVPSL", name: "Cardio", departments: ["a", "b", "c", "d", "e", "f", "g"].map((id) => ({ id, name: id })) };
    const row: AccessRow = { email: "j@x.org", name: "J", isAdmin: false, lineIds: ["L"], limits: {} };
    expect(AccessGridModel.count(AccessGridModel.setAll(row, line, false), line)).toEqual({ granted: 7, total: 7 });
    expect(AccessGridModel.count(AccessGridModel.setAll(AccessGridModel.setAll(row, line, false), line, true), line)).toBeNull();
  });

  it("switch off: every open department checked at first; switch on: back to All (rows dropped)", async () => {
    fake.state.departments.find((d) => d.id === "INU")!.archivedAt = new Date();
    expect(await DepartmentAccessService.setAll(ADMIN, JANE, CVPSL, false, db, ENV)).toEqual({ ok: true, message: "Jane Doe now sees only the checked CVPSL departments." });
    expect(fake.state.deptAccess.map((d) => d.departmentId).sort()).toEqual(["CVSS", "CardioNeuro", "Cath", "EP", "Echo", "IR"]);
    expect(fake.state.accessGrants[0].allDepartments).toBe(false);
    // Idempotent.
    await DepartmentAccessService.setAll(ADMIN, JANE, CVPSL, false, db, ENV);
    expect(fake.state.deptAccess).toHaveLength(6);
    expect(await DepartmentAccessService.setAll(ADMIN, JANE, CVPSL, true, db, ENV)).toEqual({ ok: true, message: "Jane Doe can now see all CVPSL departments." });
    expect(fake.state.deptAccess).toEqual([]);
    expect(fake.state.deptAccessHistory.map((h) => [h.action, h.changedBy])).toEqual([
      ["all_off", ADMIN.email],
      ["all_on", ADMIN.email],
    ]);
  });

  it("one department at a time; the last one removes the line (logged as a line revoke)", async () => {
    fake.limit(JANE, CVPSL, "Echo", "IR");
    expect(await DepartmentAccessService.setDepartment(ADMIN, JANE, CVPSL, "Cath", true, db, ENV)).toEqual({ ok: true, message: "Jane Doe can now see Cath Lab in CVPSL." });
    expect(await DepartmentAccessService.setDepartment(ADMIN, JANE, CVPSL, "Cath", false, db, ENV)).toEqual({ ok: true, message: "Jane Doe can no longer see Cath Lab in CVPSL." });
    await DepartmentAccessService.setDepartment(ADMIN, JANE, CVPSL, "IR", false, db, ENV);
    expect(fake.state.deptAccess.map((d) => d.departmentId)).toEqual(["Echo"]);
    expect(await DepartmentAccessService.setDepartment(ADMIN, JANE, CVPSL, "Echo", false, db, ENV)).toEqual({ ok: true, message: "Jane Doe can no longer see CVPSL." });
    expect(fake.state.accessGrants).toEqual([]);
    expect(fake.state.deptAccess).toEqual([]);
    expect(fake.state.accessHistory.map((h) => h.action)).toEqual(["revoked"]);
    expect(fake.state.deptAccessHistory.map((h) => h.action)).toEqual(["granted", "revoked", "revoked", "revoked"]);
  });

  it("refuses non-admins, admin targets, All-on lines, other lines' or archived departments, and people without the line", async () => {
    await expect(DepartmentAccessService.setAll({ email: JANE, isAdmin: false }, JANE, CVPSL, false, db, ENV)).rejects.toThrow(AdminRequiredError);
    await expect(DepartmentAccessService.setDepartment(null, JANE, CVPSL, "Echo", true, db, ENV)).rejects.toThrow(AdminRequiredError);
    const fail = { ok: false, message: "Couldn't save access. Try again." };
    expect(await DepartmentAccessService.setAll(ADMIN, ADMIN.email, CVPSL, false, db, ENV)).toEqual(fail);
    expect(await DepartmentAccessService.setDepartment(ADMIN, JANE, CVPSL, "Echo", true, db, ENV)).toEqual(fail); // All departments is on
    const ep = fake.addLine({ name: "Electrophysiology Service Line", shortName: "EP" }).id as string;
    const abl = fake.addDepartment(ep, { name: "Ablation", shortName: "Abl" }).id as string;
    fake.limit(JANE, CVPSL, "Echo");
    expect(await DepartmentAccessService.setDepartment(ADMIN, JANE, CVPSL, abl, true, db, ENV)).toEqual(fail);
    fake.state.departments.find((d) => d.id === "INU")!.archivedAt = new Date();
    expect(await DepartmentAccessService.setDepartment(ADMIN, JANE, CVPSL, "INU", true, db, ENV)).toEqual(fail);
    expect(await DepartmentAccessService.setAll(ADMIN, JANE, ep, false, db, ENV)).toEqual(fail);
    expect(fake.state.deptAccess.map((d) => d.departmentId)).toEqual(["Echo"]);
  });
});

describe("edge cases: deleted and new departments", () => {
  it("deleting a department and moving its projects moves limited people's access too, logged in the Audit log", async () => {
    const scope = await ServiceLineAccess.defaultLine(db);
    const ic = await DepartmentService.save(scope, { name: "Invasive Cardiology", shortName: "IC" }, ADMIN, db);
    await ProjectService.create({ serviceArea: "Cath", owner: "O", status: "OnTrack", nextMilestone: "M", name: "Moving project" }, actor, db);
    fake.limit(JANE, CVPSL, "Cath", "Echo");
    fake.grant("all.depts@caromonthealth.org", CVPSL); // All departments: nothing to move
    fake.grant("both@caromonthealth.org", CVPSL);
    fake.limit("both@caromonthealth.org", CVPSL, "Cath", ic.id);
    await DepartmentService.remove(scope, "Cath", { confirmName: "Cath Lab", moveTo: ic.id }, ADMIN, db);
    const byEmail = (e: string) => fake.state.deptAccess.filter((d) => d.email === e).map((d) => d.departmentId).sort();
    expect(byEmail(JANE)).toEqual(["Echo", ic.id].sort());
    expect(byEmail("both@caromonthealth.org")).toEqual([ic.id]);
    expect(byEmail("all.depts@caromonthealth.org")).toEqual([]);
    expect(fake.state.deptAccessHistory.map((h) => [h.email, h.action, h.detail])).toEqual([
      [JANE, "moved", { from: "Cath Lab", to: "Invasive Cardiology", fromId: "Cath" }],
      ["both@caromonthealth.org", "moved", { from: "Cath Lab", to: "Invasive Cardiology", fromId: "Cath" }],
    ]);
    const audit = await AdminAuditService.load(ADMIN, db, scope);
    const moves = audit.events.filter((e) => e.kind === "access");
    expect(moves.map((e) => e.comment).sort()).toEqual([
      "Both's Cath Lab access moved to Invasive Cardiology when Cath Lab was deleted.",
      "Jane Doe's Cath Lab access moved to Invasive Cardiology when Cath Lab was deleted.",
    ]);
    expect(moves[0]).toMatchObject({ by: ADMIN.email, oldValue: "Cath Lab", newValue: "Invasive Cardiology" });
    // Jane now sees Invasive Cardiology, where the project went.
    const s = await ServiceLineAccess.activeFor({ email: JANE, isAdmin: false }, db);
    expect(s.departments.map((d) => d.name)).toEqual(["Echo", "Invasive Cardiology"]);
  });

  it("a new department reaches only people with All departments on", async () => {
    fake.grant("all.depts@caromonthealth.org", CVPSL);
    fake.limit(JANE, CVPSL, "Echo");
    const scope = await ServiceLineAccess.defaultLine(db);
    await DepartmentService.save(scope, { name: "Structural Heart", shortName: "SH" }, ADMIN, db);
    const names = async (email: string) => (await ServiceLineAccess.activeFor({ email, isAdmin: false }, db)).departments.map((d) => d.name);
    expect(await names("all.depts@caromonthealth.org")).toContain("Structural Heart");
    expect(await names(JANE)).toEqual(["Echo"]);
    const g = await LineAccessService.grid(ADMIN, db, ENV);
    expect(AccessGridModel.count(g.users.find((u) => u.email === JANE)!, g.lines[0])).toEqual({ granted: 1, total: 8 });
  });
});
