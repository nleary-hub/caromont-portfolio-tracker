import { describe, expect, it } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { AdminMenu } from "@/lib/admin/AdminMenu";
import { DepartmentTable } from "@/lib/admin/DepartmentTable";
import { ReportSettingsCopy } from "@/lib/admin/ReportSettingsCopy";
import { AdminRequiredError } from "@/lib/auth/AdminPolicy";
import { DashboardGroups } from "@/lib/dashboard/DashboardGroups";
import { DepartmentCopy, DepartmentRules, DepartmentValidationError } from "@/lib/domain/DepartmentRules";
import { DepartmentFilter } from "@/lib/domain/DepartmentFilter";
import { ServiceAreaInfo, type DepartmentList } from "@/lib/domain/ServiceAreaInfo";
import type { ServiceLineScope } from "@/lib/domain/ServiceLine";
import { LayoutCopy } from "@/lib/layout/LineLayout";
import { ContractsLeadRules, ContractsLeadValidationError } from "@/lib/people/ContractsLeadRules";
import { PeopleDirectory } from "@/lib/people/PeopleDirectory";
import { HandoffBuilder } from "@/lib/report/HandoffBuilder";
import { PdfReportRenderer } from "@/lib/report/PdfReportRenderer";
import { ReportBuilder } from "@/lib/report/ReportBuilder";
import { SampleReportData } from "@/lib/report/SampleReportData";
import { ReportLayout, type DocumentLayout } from "@/lib/report/pdf/ReportLayout";
import { TextMeasure } from "@/lib/report/pdf/TextMeasure";
import { ViewSettings } from "@/lib/domain/ViewSettings";
import { AdminAuditService } from "@/lib/services/AdminAuditService";
import { DepartmentForms } from "@/lib/services/DepartmentForms";
import { DepartmentRestoreConflictError, DepartmentService } from "@/lib/services/DepartmentService";
import { LineLayoutService } from "@/lib/services/LineLayoutService";
import { PeopleService } from "@/lib/services/PeopleService";
import { ProjectService } from "@/lib/services/ProjectService";
import { SnapshotService } from "@/lib/services/SnapshotService";
import { FakeDb } from "./helpers/FakeDb";
import { Factory } from "./helpers/factories";

const ADMIN = Factory.ADMIN;
const MEMBER = Factory.MEMBER;
const actor = { changedBy: ADMIN.email };
const m = new TextMeasure();

class Fx {
  static async scope(db: PrismaClient): Promise<ServiceLineScope> {
    return ServiceLineAccess.defaultLine(db);
  }

  static async project(db: PrismaClient, name: string, serviceArea: string | null, status = "OnTrack") {
    return ProjectService.create({ name, serviceArea, owner: "Owner A", status, nextMilestone: "M1" } as never, actor, db, await Fx.scope(db));
  }

  static headings(l: DocumentLayout): string[] {
    return l.pages.flatMap((p) => p.blocks.flatMap((b) => (b.kind === "section" ? [b.label] : [])));
  }

  /** The sample report with its rows on CVPSL's real department ids (as after migration 0018). */
  static cvpsl<T extends { serviceArea: string | null }>(rows: readonly T[]): T[] {
    return rows.map((r) => ({ ...r, serviceArea: r.serviceArea ? ServiceAreaInfo.CVPSL_IDS[r.serviceArea] : null }));
  }
}

describe("DepartmentRules (validation)", () => {
  const others = [{ name: "Cath Lab", shortName: "Cath" }];
  it("requires both names, trims and collapses spaces; name up to 40, short name up to 12", () => {
    expect(DepartmentRules.parse({ name: "  Structural   Heart ", shortName: " SH " }, others, "CVPSL")).toEqual({ name: "Structural Heart", shortName: "SH" });
    expect(DepartmentRules.parse({ name: "x".repeat(40), shortName: "y".repeat(12) }, others, "CVPSL").shortName).toHaveLength(12);
    const errorsOf = (raw: { name: string; shortName: string }) => {
      try {
        DepartmentRules.parse(raw, others, "CVPSL");
        return null;
      } catch (e) {
        return (e as DepartmentValidationError).errors;
      }
    };
    expect(errorsOf({ name: "", shortName: "" })).toEqual({ name: "Name is required.", shortName: "Short name is required." });
    expect(errorsOf({ name: "x".repeat(41), shortName: "y".repeat(13) })).toEqual({ name: "Name must be 40 characters or fewer.", shortName: "Short name must be 12 characters or fewer." });
    expect(errorsOf({ name: "cath lab", shortName: "CATH" })).toEqual({
      name: "Another department in CVPSL already uses this name.",
      shortName: "Another department in CVPSL already uses this short name.",
    });
  });

  it("previews the PDF heading and grid label from the short name; copy has no em dashes", () => {
    expect(DepartmentCopy.previewPdf("Struct")).toBe("PDF heading: Struct");
    expect(DepartmentCopy.previewDashboard("Struct")).toBe("Dashboard heading: STRUCT");
    expect(DepartmentCopy.previewGrid("Struct")).toBe("Summary grid: Struct");
    const strings = Object.values(DepartmentCopy).filter((v) => typeof v === "string") as string[];
    for (const s of [...strings, DepartmentCopy.archiveBody("Echo", 2), DepartmentCopy.deleteBody("Echo", 1), DepartmentCopy.deletedToast("Echo", 2, "EP Lab")]) expect(s).not.toContain("\u2014");
    expect(DepartmentCopy.deletedToast("Echo", 2, "EP Lab")).toBe("Echo deleted. 2 projects moved to EP Lab.");
    expect(DepartmentCopy.moveLabel(1)).toBe("Move 1 project to");
  });
});

describe("department list (report order, headings, Unassigned last)", () => {
  it("CVPSL keeps today's seven in today's order, and Echo, CVSS and INU keep their own headings", () => {
    expect(ServiceAreaInfo.CVPSL.map((d) => d.shortName)).toEqual(["Cath", "EP", "Echo", "CVSS", "INU", "CardioNeuro", "IR"]);
    expect(ServiceAreaInfo.CVPSL.map((d) => d.name)).toEqual(["Cath Lab", "EP Lab", "Echo", "CVSS", "INU", "CardioNeuro", "IR"]);
    const groups = ServiceAreaInfo.groups(ServiceAreaInfo.CVPSL);
    expect(groups.map((g) => ServiceAreaInfo.label(g, ServiceAreaInfo.CVPSL))).toEqual(["Cath", "EP", "Echo", "CVSS", "INU", "CardioNeuro", "IR", "Unassigned"]);
  });

  it("Unassigned sorts last whatever the order; archived departments show only when they still have rows", () => {
    const list: DepartmentList = [
      { id: "b", name: "Bravo", shortName: "B" },
      { id: "a", name: "Alpha", shortName: "A", archived: true },
    ];
    expect(ServiceAreaInfo.groups(list, [])).toEqual(["b", "Unassigned"]);
    expect(ServiceAreaInfo.groups(list, ["a", null])).toEqual(["b", "a", "Unassigned"]);
    expect(DepartmentFilter.optionsFor({ departments: list })).toEqual(["b"]);
  });

  it("row-drag announcements use the department's full name", () => {
    const rows = [{ serviceArea: ServiceAreaInfo.CVPSL_IDS.Cath }, { serviceArea: null }];
    const groups = DashboardGroups.group(rows, [], undefined, ServiceAreaInfo.CVPSL);
    expect(groups.map((g) => [g.label, g.name])).toEqual([
      ["Cath", "Cath Lab"],
      ["Unassigned", "Unassigned"],
    ]);
    expect(LayoutCopy.rowMoved(2, 5, groups[0].name)).toBe("Moved to position 2 of 5 in Cath Lab");
    expect(DepartmentTable.moved(3, 7)).toBe("Moved to position 3 of 7.");
  });
});

describe("DepartmentService", () => {
  it("creates at the bottom, edits, and audits both; admin only", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    const scope = await Fx.scope(db);
    const sh = await DepartmentService.save(scope, { name: "Structural Heart", shortName: "SH" }, ADMIN, db);
    expect(sh.position).toBe(8);
    await DepartmentService.save(scope, { id: sh.id, name: "Structural Heart Program", shortName: "SHP" }, ADMIN, db);
    const after = await Fx.scope(db);
    expect(after.departments.map((d) => d.shortName)).toEqual(["Cath", "EP", "Echo", "CVSS", "INU", "CardioNeuro", "IR", "SHP"]);
    expect(fake.state.departmentHistory.map((h) => h.action)).toEqual(["created", "edited"]);
    expect(fake.state.departmentHistory[1]).toMatchObject({ oldValue: { name: "Structural Heart", shortName: "SH" }, newValue: { name: "Structural Heart Program", shortName: "SHP" }, changedBy: ADMIN.email });
    await expect(DepartmentService.save(scope, { name: "echo", shortName: "E2" }, ADMIN, db)).rejects.toThrow(DepartmentValidationError);
    const writes = fake.writes.length;
    await expect(DepartmentService.save(scope, { name: "X", shortName: "X" }, MEMBER, db)).rejects.toThrow(AdminRequiredError);
    await expect(DepartmentService.list(scope, MEMBER, db)).rejects.toThrow(AdminRequiredError);
    expect(fake.writes).toHaveLength(writes);
  });

  it("reorders the report order in one audited change; the PDF and dashboard follow it, Unassigned still last", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    const scope = await Fx.scope(db);
    await DepartmentService.reorder(scope, ["IR", "Cath"], ADMIN, db);
    const after = await Fx.scope(db);
    expect(after.departments.map((d) => d.id)).toEqual(["IR", "Cath", "EP", "Echo", "CVSS", "INU", "CardioNeuro"]);
    expect(ServiceAreaInfo.groups(after.departments).at(-1)).toBe("Unassigned");
    expect(fake.state.departmentHistory).toHaveLength(1);
    expect(fake.state.departmentHistory[0]).toMatchObject({ action: "moved", departmentId: null, newValue: ["IR", "Cath Lab", "EP Lab", "Echo", "CVSS", "INU", "CardioNeuro"] });
    const rows = ReportBuilder.sort([{ serviceArea: "Cath", name: "a" }, { serviceArea: "IR", name: "b" }] as never, after.departments) as { serviceArea: string }[];
    expect(rows.map((r) => r.serviceArea)).toEqual(["IR", "Cath"]);
  });

  it("archive hides it from filters and pick-lists but keeps its projects grouped under it; unarchive puts it at the bottom", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    await Fx.project(db, "Echo one", "Echo");
    const scope = await Fx.scope(db);
    await DepartmentService.archive(scope, "Echo", ADMIN, db);
    let s = await Fx.scope(db);
    expect(DepartmentFilter.optionsFor(s)).not.toContain("Echo");
    expect(ServiceAreaInfo.groups(s.departments, ["Echo"])).toContain("Echo");
    const lists = await DepartmentService.list(s, ADMIN, db);
    expect(lists.archived.map((d) => [d.name, d.activeProjects])).toEqual([["Echo", 1]]);
    await DepartmentService.unarchive(s, "Echo", ADMIN, db);
    s = await Fx.scope(db);
    expect(ServiceAreaInfo.all(s.departments).at(-1)).toBe("Echo");
    expect(fake.state.departmentHistory.map((h) => h.action)).toEqual(["archived", "unarchived"]);
  });

  it("delete moves active projects to the chosen department (history and row order), keeps closed projects' name, and is restorable", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    const a = await Fx.project(db, "Active one", "INU");
    const b = await Fx.project(db, "Active two", "INU");
    const done = await Fx.project(db, "Done", "INU", "Complete");
    const ep = await Fx.project(db, "EP one", "EP");
    const scope = await Fx.scope(db);
    await LineLayoutService.setRowOrder("EP", [ep.id], ADMIN, db, scope);
    await LineLayoutService.setRowOrder("INU", [b.id, a.id], ADMIN, db, scope);

    await expect(DepartmentService.remove(scope, "INU", { confirmName: "inu", moveTo: "EP" }, ADMIN, db)).rejects.toMatchObject({ errors: { confirm: "The name doesn't match." } });
    await expect(DepartmentService.remove(scope, "INU", { confirmName: "INU" }, ADMIN, db)).rejects.toMatchObject({ errors: { moveTo: "Choose a department" } });
    const r = await DepartmentService.remove(scope, "INU", { confirmName: "INU", moveTo: "EP" }, ADMIN, db);
    expect(r).toEqual({ name: "INU", moved: 2, to: "EP Lab" });

    const byId = (id: string) => fake.state.projects.find((p) => p.id === id)!;
    expect([byId(a.id).serviceArea, byId(b.id).serviceArea, byId(done.id).serviceArea]).toEqual(["EP", "EP", "INU"]);
    const moves = fake.state.history.filter((h) => h.field === "serviceArea" && h.oldValue === "INU");
    expect(moves.map((h) => [h.projectId, h.newValue])).toEqual([
      [a.id, "EP"],
      [b.id, "EP"],
    ]);
    const layout = await LineLayoutService.get(db, await Fx.scope(db));
    expect(layout.rows.EP).toEqual([ep.id, a.id, b.id]);
    expect(layout.rows.INU).toBeUndefined();

    // Deleted: gone from the admin list and the filter, but a completed project still shows "INU".
    const s = await Fx.scope(db);
    expect((await DepartmentService.list(s, ADMIN, db)).active.map((d) => d.id)).not.toContain("INU");
    expect(DepartmentFilter.optionsFor(s)).not.toContain("INU");
    expect(ServiceAreaInfo.label("INU", s.departments)).toBe("INU");
    expect(fake.state.departmentHistory.at(-1)).toMatchObject({ action: "deleted", newValue: { movedTo: "EP Lab", moved: 2 } });

    // Audit lists it; restore brings it back at the bottom.
    const audit = await AdminAuditService.load(ADMIN, db, s);
    expect(audit.deletedDepartments.map((d) => d.name)).toEqual(["INU"]);
    expect(audit.events.some((e) => e.kind === "department" && e.field === "department.deleted" && e.subject === "INU")).toBe(true);
    expect(await DepartmentForms.restore(ADMIN, "INU", db)).toMatchObject({ ok: true });
    expect(ServiceAreaInfo.all((await Fx.scope(db)).departments).at(-1)).toBe("INU");
  });

  it("a department with no active projects deletes without a move; there is no hard delete", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    const scope = await Fx.scope(db);
    expect(await DepartmentService.remove(scope, "CardioNeuro", { confirmName: "CardioNeuro" }, ADMIN, db)).toEqual({ name: "CardioNeuro", moved: 0, to: null });
    expect(fake.state.departments.find((d) => d.id === "CardioNeuro")).toMatchObject({ deletedBy: ADMIN.email });
    expect(fake.writes.some((w) => w.model === "department" && w.op === "delete")).toBe(false);
  });

  it("restore is blocked with the name-conflict message when another department took the name or short name", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    const scope = await Fx.scope(db);
    await DepartmentService.remove(scope, "IR", { confirmName: "IR" }, ADMIN, db);
    await DepartmentService.save(await Fx.scope(db), { name: "Interventional Radiology", shortName: "IR" }, ADMIN, db);
    await expect(DepartmentService.restore("IR", ADMIN, db)).rejects.toThrow(DepartmentRestoreConflictError);
    expect(await DepartmentForms.restore(ADMIN, "IR", db)).toEqual({
      ok: false,
      message: "Another department in this line now uses this name or short name. Rename that one, then restore this one.",
    });
    expect(fake.state.departments.find((d) => d.id === "IR")!.deletedAt).not.toBeNull();
  });

  it("a frozen snapshot keeps the department names it was frozen with after a rename", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    await Fx.project(db, "Alpha", "Cath");
    const snap = await SnapshotService.create({ periodStart: "2026-09-16", periodEnd: "2026-09-29", generatedBy: "cron", now: new Date("2026-09-29T21:30:00Z") }, db);
    await DepartmentService.save(await Fx.scope(db), { id: "Cath", name: "Cardiac Cath Lab", shortName: "CCL" }, ADMIN, db);
    const frozen = PdfReportRenderer.inputFromSnapshot(fake.state.snapshots[0] as never);
    expect(Fx.headings(ReportLayout.layout(PdfReportRenderer.docInput(frozen), m))).toContain("Cath");
    expect(Fx.headings(ReportLayout.layout(PdfReportRenderer.docInput(frozen), m))).not.toContain("CCL");
    expect((snap as { departmentsJson: unknown }).departmentsJson).toEqual(expect.arrayContaining([expect.objectContaining({ id: "Cath", name: "Cath Lab", shortName: "Cath" })]));
    // A snapshot frozen before 0018 (no departmentsJson) renders with today's seven.
    const old = PdfReportRenderer.inputFromSnapshot({ ...(fake.state.snapshots[0] as object), departmentsJson: null } as never);
    expect(Fx.headings(ReportLayout.layout(PdfReportRenderer.docInput(old), m))).toContain("Cath");
  });
});

describe("default CVPSL output is unchanged on the new department ids", () => {
  it("handoff.json is byte-identical with CVPSL's department list and ids", () => {
    const doc = SampleReportData.docInput();
    const rows = doc.rows.filter((r) => ViewSettings.isStatusVisible(doc.viewSettings, r.status));
    const base = {
      snapshotId: "s",
      periodStart: SampleReportData.PERIOD_START,
      periodEnd: SampleReportData.PERIOD_END,
      reportDate: SampleReportData.REPORT_DATE,
      frozenAt: SampleReportData.GENERATED_AT,
      pdf: { fileName: "r.pdf", sha256: "0".repeat(64), byteSize: 1 },
      baseUrl: "https://example.org",
      reportRecipient: "frank@example.org",
      serviceLineName: doc.serviceLine?.name,
    };
    const legacy = HandoffBuilder.toBytes(HandoffBuilder.build({ ...base, rows, header: doc.header, completed: doc.completed }));
    const idRows = Fx.cvpsl(rows);
    const header = { ...ReportBuilder.header(idRows, ServiceAreaInfo.CVPSL), completedFiscalYear: doc.header!.completedFiscalYear };
    const ids = HandoffBuilder.toBytes(HandoffBuilder.build({ ...base, rows: idRows, header, completed: Fx.cvpsl(doc.completed ?? []), departmentList: ServiceAreaInfo.CVPSL }));
    expect(ids.toString("utf8")).toBe(legacy.toString("utf8"));
  });

  it("the default PDF is byte-identical with CVPSL's department list and ids", async () => {
    const doc = SampleReportData.docInput();
    const visible = doc.rows.filter((r) => ViewSettings.isStatusVisible(doc.viewSettings, r.status));
    const idRows = Fx.cvpsl(doc.rows);
    const idDoc = SampleReportData.docInput({
      rows: idRows,
      header: { ...ReportBuilder.header(Fx.cvpsl(visible), ServiceAreaInfo.CVPSL), completedFiscalYear: doc.header!.completedFiscalYear },
      completed: Fx.cvpsl(doc.completed ?? []),
      lineDepartments: ServiceAreaInfo.CVPSL,
    });
    // Only the creation date and the document ID differ between any two renders; mask exactly those.
    const mask = (bytes: Uint8Array) =>
      Buffer.from(bytes)
        .toString("latin1")
        .replace(/\(D:\d{14}Z\)/g, "(D:masked)")
        .replace(/\/ID \[<[0-9a-f]+> <[0-9a-f]+>\]/gi, "/ID [masked]");
    const a = mask(await PdfReportRenderer.renderDocument(doc));
    const b = mask(await PdfReportRenderer.renderDocument(idDoc));
    expect(b.length).toBe(a.length);
    expect(b === a).toBe(true);
  });

  it("handoff.json area follows a renamed short name (approved)", () => {
    const list = ServiceAreaInfo.CVPSL.map((d) => (d.shortName === "Cath" ? { ...d, shortName: "CCL" } : d));
    const rows = Fx.cvpsl(SampleReportData.rows()).filter((r) => r.serviceArea === ServiceAreaInfo.CVPSL_IDS.Cath && r.changed);
    const h = HandoffBuilder.build({
      snapshotId: "s",
      periodStart: "2026-09-16",
      periodEnd: "2026-09-29",
      reportDate: "2026-09-29",
      frozenAt: new Date(),
      rows,
      header: null,
      pdf: { fileName: "x", sha256: "0", byteSize: 1 },
      baseUrl: null,
      reportRecipient: null,
      departmentList: list,
    });
    expect(JSON.stringify(h)).toContain('"CCL"');
    expect(JSON.stringify(h)).not.toContain(ServiceAreaInfo.CVPSL_IDS.Cath);
  });
});

describe("People (contracts leads) and Report settings", () => {
  it("lists the line's contracts leads with project counts, adds at the end, rejects duplicates and names over 200", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    const p = await Fx.project(db, "Alpha", "Cath");
    await ProjectService.update(p.id, { contractsLead: "Jeff Krause" } as never, actor, db, await Fx.scope(db)).catch(() => undefined);
    fake.state.projects.find((x) => x.id === p.id)!.contractsLead = "Jeff Krause";
    const scope = await Fx.scope(db);
    const rows = await PeopleService.contractsLeads(scope, ADMIN, db);
    // Shown A to Z (PR #25 review); the stored order is unchanged and new names still go at the end.
    expect(rows.map((r) => r.name)).toEqual(["Amber Hatley", "Dave Dermady", "Jeff Krause", "Mellisa Gonzales", "Shea Waldron"]);
    expect(rows.find((r) => r.name === "Jeff Krause")!.projects).toBe(1);
    expect(await PeopleService.addContractsLead(scope, "  Pat   Lee ", ADMIN, db)).toBe("Pat Lee");
    const s2 = await Fx.scope(db);
    expect(s2.contractsLeads.at(-1)).toBe("Pat Lee");
    await expect(PeopleService.addContractsLead(s2, "pat lee", ADMIN, db)).rejects.toThrow("Pat Lee is already a contracts lead.");
    expect(ContractsLeadRules.NAME_MAX).toBe(PeopleDirectory.NAME_MAX);
    expect(PeopleDirectory.NAME_MAX).toBe(200);
    expect(() => ContractsLeadRules.parse("x".repeat(201), [])).toThrow(ContractsLeadValidationError);
    expect(ContractsLeadRules.parse("x".repeat(200), [])).toHaveLength(200);
    await PeopleService.removeContractsLead(s2, "Jeff Krause", ADMIN, db);
    expect((await Fx.scope(db)).contractsLeads).not.toContain("Jeff Krause");
    // Projects keep the lead they have.
    expect(fake.state.projects.find((x) => x.id === p.id)!.contractsLead).toBe("Jeff Krause");
    expect(fake.state.serviceLineHistory.filter((h) => h.action === "contracts_leads_changed")).toHaveLength(2);
    await expect(PeopleService.contractsLeads(scope, MEMBER, db)).rejects.toThrow(AdminRequiredError);
    expect(await DepartmentForms.addContractsLead(MEMBER, "X", db)).toEqual({ ok: false, message: "Not authorized." });
  });

  it("copy: remove confirm, empty state, and the Report settings pointer", () => {
    expect(ContractsLeadRules.removeTitle("Jeff Krause")).toBe("Remove Jeff Krause from contracts leads?");
    expect(ContractsLeadRules.removeBody("Jeff Krause", 2)).toBe("2 projects list Jeff Krause as contracts lead. They keep that name, but new projects won't offer it.");
    expect(ContractsLeadRules.EMPTY).toBe("No contracts leads yet. Add the people who handle contracts for this service line.");
    expect(ReportSettingsCopy.pointerText()).toBe("Contracts leads are now on the People page");
    expect(ReportSettingsCopy.POINTER_LINK).toBe("People");
    expect(AdminMenu.REPORT_SETTINGS).toBe("Report settings");
  });
});
