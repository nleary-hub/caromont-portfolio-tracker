import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AdminRequiredError } from "@/lib/auth/AdminPolicy";
import { ServiceLineLabel } from "@/components/ServiceLineLabel";
import { ServiceLine, ServiceLineCopy, ServiceLineValidationError } from "@/lib/domain/ServiceLine";
import { HandoffBuilder } from "@/lib/report/HandoffBuilder";
import { PdfReportLayout } from "@/lib/report/PdfReportLayout";
import { PdfReportRenderer } from "@/lib/report/PdfReportRenderer";
import { ReportGeometry, ReportLayout } from "@/lib/report/pdf/ReportLayout";
import { TextMeasure } from "@/lib/report/pdf/TextMeasure";
import { SampleReportData } from "@/lib/report/SampleReportData";
import { ProjectService } from "@/lib/services/ProjectService";
import { ServiceLineForms } from "@/lib/services/ServiceLineForms";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { ServiceLineService } from "@/lib/services/ServiceLineService";
import { AdminAuditService } from "@/lib/services/AdminAuditService";
import { ServiceLineTable } from "@/lib/admin/ServiceLineTable";
import { DashboardViewModel } from "@/lib/dashboard/DashboardViewModel";
import { SnapshotService } from "@/lib/services/SnapshotService";
import { Factory } from "./helpers/factories";
import { FakeDb } from "./helpers/FakeDb";

const ADMIN = Factory.ADMIN;
const MEMBER = { email: "member@example.org", isAdmin: false };
const SEED = { name: "Cardiovascular & Pulmonary Service Line", shortName: "CVPSL" };

describe("ServiceLine (pure rules)", () => {
  it("seeds the full and short names", () => {
    expect(ServiceLine.defaults()).toEqual(SEED);
    expect(ServiceLine.reportTitle(SEED)).toBe("Cardiovascular & Pulmonary Service Line: Project Status Report");
  });

  it("the default scope keeps all seven CVPSL departments in their current order and the current contracts leads", () => {
    const s = ServiceLine.defaultScope();
    expect(s).toMatchObject({ id: ServiceLine.DEFAULT_ID, isDefault: true, ...SEED });
    expect(s.departments.map((d) => d.id)).toEqual(["Cath", "EP", "Echo", "CVSS", "INU", "CardioNeuro", "IR"]);
    expect(s.departments.map((d) => [d.name, d.shortName])).toEqual([
      ["Cath Lab", "Cath"],
      ["EP Lab", "EP"],
      ["Echo", "Echo"],
      ["CVSS", "CVSS"],
      ["INU", "INU"],
      ["CardioNeuro", "CardioNeuro"],
      ["IR", "IR"],
    ]);
    expect(s.contractsLeads).toEqual(["Shea Waldron", "Jeff Krause", "Mellisa Gonzales", "Dave Dermady", "Amber Hatley"]);
  });

  it("requires both names, trims and collapses spaces; name up to 80, short name 2 to 12 of A-Z and 0-9", () => {
    expect(ServiceLine.parse({ name: "  Heart   and Lung  ", shortName: " HL " })).toEqual({ name: "Heart and Lung", shortName: "HL" });
    expect(ServiceLine.parse({ name: "x".repeat(80), shortName: "A1".repeat(6) }).shortName).toHaveLength(12);
    const errorsOf = (raw: { name: string; shortName: string }) => {
      try {
        ServiceLine.parse(raw);
        return null;
      } catch (e) {
        return (e as ServiceLineValidationError).errors;
      }
    };
    expect(errorsOf({ name: " ", shortName: "" })).toEqual({ name: "Name is required.", shortName: "Short name is required." });
    expect(errorsOf({ name: "x".repeat(81), shortName: "A".repeat(13) })).toEqual({
      name: "Name must be 80 characters or fewer.",
      shortName: "Short name must be 2 to 12 characters.",
    });
    expect(errorsOf({ name: "Heart", shortName: "H" })?.shortName).toBe("Short name must be 2 to 12 characters.");
    // Letters are uppercased; spaces and symbols are rejected.
    expect(ServiceLine.parse({ name: "Heart", shortName: "hvsl" }).shortName).toBe("HVSL");
    expect(errorsOf({ name: "Heart", shortName: "H-V" })?.shortName).toBe("Use letters and numbers only, with no spaces or symbols.");
    expect(errorsOf({ name: "Heart", shortName: "H V" })?.shortName).toBe("Use letters and numbers only, with no spaces or symbols.");
  });

  it("suggests the short name from the name's initials (one word: its first three letters)", () => {
    expect(ServiceLine.suggestShortName("Oncology Service Line")).toBe("OSL");
    expect(ServiceLine.suggestShortName("Women's & Children's Health 2")).toBe("WCH2");
    expect(ServiceLine.suggestShortName("Oncology")).toBe("ONC");
    expect(ServiceLine.suggestShortName("   ")).toBe("");
    expect(ServiceLine.suggestShortName("a b c d e f g h i j k l m n")).toBe("ABCDEFGHIJKL");
  });

  it("editor previews", () => {
    expect(ServiceLine.topBarPreview("CVPSL")).toBe("Top bar: CVPSL");
    expect(ServiceLine.runningHeaderPreview("CVPSL")).toBe("PDF running header: CVPSL \u00b7 Project Status Report");
  });

  it("switcher order: the default line first, then A to Z (case-insensitive)", () => {
    const lines = [
      { name: "oncology", isDefault: false },
      { name: "Behavioral Health", isDefault: false },
      { name: "Cardiovascular & Pulmonary Service Line", isDefault: true },
      { name: "Ambulatory", isDefault: false },
    ];
    expect(ServiceLine.sortForSwitcher(lines).map((l) => l.name)).toEqual(["Cardiovascular & Pulmonary Service Line", "Ambulatory", "Behavioral Health", "oncology"]);
  });

  it("normalize falls back to the seed for missing or invalid parts", () => {
    expect(ServiceLine.normalize(null)).toEqual(SEED);
    expect(ServiceLine.normalize({ name: "Heart", shortName: "" })).toEqual({ name: "Heart", shortName: "CVPSL" });
  });

  it("contracts leads parse as saved", () => {
    expect(ServiceLine.parseContractsLeads([" Pat  Lee ", "", "pat lee", "Sam Roe"])).toEqual(["Pat Lee", "Sam Roe"]);
    expect(() => ServiceLine.parseContractsLeads(["x".repeat(201)])).toThrow(ServiceLineValidationError);
  });
});

describe("ServiceLineCopy (Writing Bot rules)", () => {
  it("fixed strings", () => {
    expect(ServiceLineCopy.PAGE_TITLE).toBe("Service lines");
    expect(ServiceLineCopy.NEW_BUTTON).toBe("+ New service line");
    expect(ServiceLineCopy.LOCK_TOOLTIP).toBe("The default service line can't be archived or deleted.");
    expect(ServiceLineCopy.NEW_LINE_HELP).toBe("Departments, people and templates start empty. Add them from Admin after switching to this line.");
    expect(ServiceLineCopy.confirmLabel("Bariatric Health")).toBe("Type Bariatric Health to confirm");
    expect(ServiceLineCopy.SHORT_HINT).toBe("2 to 12 letters or numbers, no spaces.");
    expect(ServiceLineCopy.SHORT_FORMAT_ERROR).toBe("Use letters and numbers only, with no spaces or symbols.");
    expect(ServiceLineCopy.PREVIEW_LABEL).toBe("Preview");
    expect(ServiceLineCopy.FORM_ERROR).toBe("Fix the fields marked in red.");
    expect(ServiceLineCopy.onDemandNote("BHSL")).toBe("BHSL uses on-demand PDFs. Click Generate PDF now to make one.");
    expect(ServiceLineCopy.footerError({})).toBe("");
    expect(ServiceLineCopy.footerError({ shortName: "x" })).toBe("Fix the fields marked in red.");
    expect(ServiceLineCopy.footerError({ _form: "That name is taken." , name: "x" })).toBe("That name is taken.");
    expect(ServiceLineCopy.MANAGE_LINK).toBe("Manage service lines");
    expect(ServiceLineCopy.COLUMNS).toEqual(["Name", "Short name", "Projects", "Updated"]);
    expect(ServiceLineCopy.archivedHeading(2)).toBe("Archived (2)");
    expect(ServiceLineCopy.switchedToast("CVPSL")).toBe("Switched to CVPSL");
  });

  it("delete confirm: title, plural, singular and zero-project bodies", () => {
    expect(ServiceLineCopy.deleteTitle("Oncology Service Line")).toBe("Delete Oncology Service Line?");
    expect(ServiceLineCopy.deleteBody("Bariatric Health", 3)).toBe("This hides Bariatric Health and its 3 projects, people lists and templates everywhere. You can restore it from Audit.");
    expect(ServiceLineCopy.deleteBody("Bariatric Health", 1)).toBe("This hides Bariatric Health and its 1 project, people lists and templates everywhere. You can restore it from Audit.");
    expect(ServiceLineCopy.deleteBody("Bariatric Health", 0)).toBe("This hides Bariatric Health and its people lists and templates everywhere. You can restore it from Audit.");
  });

  it("the typed name must match exactly (case-sensitive, outer spaces trimmed)", () => {
    expect(ServiceLineCopy.confirmMatches("Oncology Service Line", "Oncology Service Line")).toBe(true);
    expect(ServiceLineCopy.confirmMatches("  Oncology Service Line ", "Oncology Service Line")).toBe(true);
    expect(ServiceLineCopy.confirmMatches("oncology service line", "Oncology Service Line")).toBe(false);
    expect(ServiceLineCopy.confirmMatches("Oncology  Service Line", "Oncology Service Line")).toBe(false);
    expect(ServiceLineCopy.confirmMatches("", "Oncology Service Line")).toBe(false);
  });

  it("no em dashes in any service line copy", () => {
    const all = [
      ...Object.values(ServiceLineCopy).filter((v): v is string => typeof v === "string"),
      ...ServiceLineCopy.COLUMNS,
      ServiceLineCopy.deleteBody("X", 0),
      ServiceLineCopy.deleteBody("X", 1),
      ServiceLineCopy.deleteBody("X", 2),
      ServiceLineCopy.confirmLabel("X"),
      ServiceLineCopy.onDemandNote("X"),
      ServiceLineCopy.deleteTitle("X"),
    ];
    for (const text of all) expect(text).not.toContain("\u2014");
  });
});

describe("ServiceLineService", () => {
  it("renaming the default line writes the row and one audit entry (old, new, who, when) in one transaction", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    const before = Date.now();
    const saved = await ServiceLineService.update(ServiceLine.DEFAULT_ID, { name: "Heart and Vascular Service Line", shortName: "HVSL" }, ADMIN, db);
    expect(saved).toMatchObject({ id: ServiceLine.DEFAULT_ID, name: "Heart and Vascular Service Line", shortName: "HVSL", isDefault: true });
    expect(fake.state.serviceLines[0]).toMatchObject({ name: "Heart and Vascular Service Line", updatedBy: ADMIN.email });
    expect(fake.state.serviceLineHistory).toHaveLength(1);
    const h = fake.state.serviceLineHistory[0];
    expect(h).toMatchObject({ serviceLineId: ServiceLine.DEFAULT_ID, action: "renamed", oldValue: SEED, newValue: { name: "Heart and Vascular Service Line", shortName: "HVSL" }, changedBy: ADMIN.email });
    expect((h.changedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect(fake.writes.filter((w) => w.model.startsWith("serviceLine")).every((w) => w.inTx)).toBe(true);
    const changes = await ServiceLineService.history({ id: ServiceLine.DEFAULT_ID }, ADMIN, 20, db);
    expect(changes).toHaveLength(1);
  });

  it("an unchanged save writes nothing", async () => {
    const fake = new FakeDb();
    await ServiceLineService.update(ServiceLine.DEFAULT_ID, { name: SEED.name, shortName: ` ${SEED.shortName} ` }, ADMIN, fake.asClient());
    expect(fake.writes).toHaveLength(0);
  });

  it("creates a line with empty departments, people and templates; names are unique among lines not deleted", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    const onc = await ServiceLineService.create({ name: "Oncology Service Line", shortName: "ONC" }, ADMIN, db);
    expect(onc).toMatchObject({ name: "Oncology Service Line", shortName: "ONC", isDefault: false, departments: [], contractsLeads: [] });
    expect(fake.state.serviceLineHistory.at(-1)).toMatchObject({ serviceLineId: onc.id, action: "created" });
    await expect(ServiceLineService.create({ name: " oncology   service line ", shortName: "ONC2" }, ADMIN, db)).rejects.toMatchObject({
      errors: { name: "Another service line already uses this name." },
    });
    await expect(ServiceLineService.create({ name: "Other", shortName: "CVPSL" }, ADMIN, db)).rejects.toMatchObject({
      errors: { shortName: "Another service line already uses this short name." },
    });
    // After a delete the name is free again, and restoring then clashes.
    await ServiceLineService.softDelete(onc.id, "Oncology Service Line", ADMIN, db);
    const again = await ServiceLineService.create({ name: "Oncology Service Line", shortName: "ONC" }, ADMIN, db);
    await expect(ServiceLineService.restore(onc.id, ADMIN, db)).rejects.toThrow(ServiceLineValidationError);
    await ServiceLineService.softDelete(again.id, "Oncology Service Line", ADMIN, db);
    await ServiceLineService.restore(onc.id, ADMIN, db);
    expect(fake.state.serviceLines.find((l) => l.id === onc.id)).toMatchObject({ deletedAt: null, deletedBy: null });
  });

  it("archive, unarchive, delete and restore are logged; the default line can't be archived or deleted", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    const onc = await ServiceLineService.create({ name: "Oncology Service Line", shortName: "ONC" }, ADMIN, db);
    await ServiceLineService.archive(onc.id, ADMIN, db);
    let lists = await ServiceLineService.list(ADMIN, db);
    expect(lists.active.map((l) => l.shortName)).toEqual(["CVPSL"]);
    expect(lists.archived.map((l) => l.shortName)).toEqual(["ONC"]);
    await ServiceLineService.unarchive(onc.id, ADMIN, db);
    await expect(ServiceLineService.softDelete(onc.id, "oncology service line", ADMIN, db)).rejects.toMatchObject({ errors: { confirm: "The name doesn't match." } });
    await ServiceLineService.softDelete(onc.id, "  Oncology Service Line ", ADMIN, db);
    lists = await ServiceLineService.list(ADMIN, db);
    expect([...lists.active, ...lists.archived].map((l) => l.shortName)).toEqual(["CVPSL"]);
    expect((await ServiceLineService.deleted(ADMIN, db)).map((l) => l.shortName)).toEqual(["ONC"]);
    await ServiceLineService.restore(onc.id, ADMIN, db);
    expect(fake.state.serviceLineHistory.filter((h) => h.serviceLineId === onc.id).map((h) => h.action)).toEqual(["created", "archived", "unarchived", "deleted", "restored"]);

    for (const run of [
      () => ServiceLineService.archive(ServiceLine.DEFAULT_ID, ADMIN, db),
      () => ServiceLineService.softDelete(ServiceLine.DEFAULT_ID, SEED.name, ADMIN, db),
    ]) {
      await expect(run()).rejects.toMatchObject({ errors: { _form: "The default service line can't be archived or deleted." } });
    }
    expect(fake.state.serviceLines[0]).toMatchObject({ archivedAt: null, deletedAt: null });
  });

  it("contracts leads are editable for every line (departments now live on the Departments page)", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    const onc = await ServiceLineService.create({ name: "Oncology Service Line", shortName: "ONC" }, ADMIN, db);
    expect("setDepartments" in ServiceLineService).toBe(false);
    expect(fake.state.serviceLines[0].departments).toEqual(["Cath", "EP", "Echo", "CVSS", "INU", "CardioNeuro", "IR"]);
    expect((await ServiceLineService.setContractsLeads(onc.id, ["Pat Lee"], ADMIN, db)).contractsLeads).toEqual(["Pat Lee"]);
    expect(fake.state.serviceLines[0].contractsLeads).toEqual(ServiceLine.CVPSL_CONTRACTS_LEADS);
    expect(fake.state.serviceLineHistory.filter((h) => h.serviceLineId === onc.id).map((h) => h.action)).toEqual(["created", "contracts_leads_changed"]);
  });

  it("rejects non-admins and writes nothing", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    await expect(ServiceLineService.create({ name: "X Line", shortName: "XL" }, MEMBER, db)).rejects.toThrow(AdminRequiredError);
    await expect(ServiceLineService.update(ServiceLine.DEFAULT_ID, { name: "X", shortName: "XL" }, MEMBER, db)).rejects.toThrow(AdminRequiredError);
    await expect(ServiceLineService.list(MEMBER, db)).rejects.toThrow(AdminRequiredError);
    await expect(ServiceLineService.history({ id: ServiceLine.DEFAULT_ID }, MEMBER, 20, db)).rejects.toThrow(AdminRequiredError);
    expect(fake.writes).toHaveLength(0);
  });
});

describe("ServiceLineForms (the Server Action bodies)", () => {
  it("returns Not authorized for non-admins and no viewer, writing nothing", async () => {
    const fake = new FakeDb();
    expect(await ServiceLineForms.save(MEMBER, { name: "X Line", shortName: "XL" }, fake.asClient())).toEqual({ ok: false, message: "Not authorized." });
    expect(await ServiceLineForms.save(null, { name: "X Line", shortName: "XL" }, fake.asClient())).toEqual({ ok: false, message: "Not authorized." });
    expect(await ServiceLineForms.switchTo(MEMBER, ServiceLine.DEFAULT_ID, fake.asClient())).toEqual({ ok: false, message: "Not authorized." });
    expect(fake.writes).toHaveLength(0);
  });

  it("returns field errors for invalid input and saves valid input", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    const bad = await ServiceLineForms.save(ADMIN, { name: "", shortName: "WAYTOOLONGNAME" }, db);
    expect(bad).toMatchObject({ ok: false, errors: { name: "Name is required.", shortName: "Short name must be 2 to 12 characters." } });
    expect(fake.writes).toHaveLength(0);
    const good = await ServiceLineForms.save(ADMIN, { name: "Heart Line", shortName: "HL" }, db);
    expect(good).toMatchObject({ ok: true, line: { name: "Heart Line", shortName: "HL" } });
  });

  it("switching saves the active line per user; archiving or deleting the active line switches to CVPSL with a toast", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    const onc = fake.addLine({ name: "Oncology Service Line", shortName: "ONC" });
    const other = { email: "other@example.org", isAdmin: true };
    expect(await ServiceLineForms.switchTo(ADMIN, onc.id as string, db)).toMatchObject({ ok: true, switchedTo: "ONC" });
    expect((await ServiceLineAccess.activeFor(ADMIN, db)).shortName).toBe("ONC");
    expect((await ServiceLineAccess.activeFor(other, db)).shortName).toBe("CVPSL");

    // Archiving a line someone else has open does not toast for me.
    expect(await ServiceLineForms.archive(other, onc.id as string, db)).toEqual({ ok: true, message: "Archived." });
    // My saved line is archived: I read the default line.
    expect((await ServiceLineAccess.activeFor(ADMIN, db)).shortName).toBe("CVPSL");
    await ServiceLineForms.unarchive(ADMIN, onc.id as string, db);
    await ServiceLineForms.switchTo(ADMIN, onc.id as string, db);
    expect(await ServiceLineForms.archive(ADMIN, onc.id as string, db)).toEqual({ ok: true, message: "Switched to CVPSL", switchedTo: "CVPSL" });
    expect(fake.state.serviceLineUserState.find((u) => u.email === ADMIN.email)).toMatchObject({ serviceLineId: ServiceLine.DEFAULT_ID });

    await ServiceLineForms.unarchive(ADMIN, onc.id as string, db);
    await ServiceLineForms.switchTo(ADMIN, onc.id as string, db);
    expect(await ServiceLineForms.remove(ADMIN, onc.id as string, "Wrong", db)).toMatchObject({ ok: false, errors: { confirm: "The name doesn't match." } });
    expect(await ServiceLineForms.remove(ADMIN, onc.id as string, "Oncology Service Line", db)).toEqual({ ok: true, message: "Switched to CVPSL", switchedTo: "CVPSL" });
    // A deleted or archived line can't be switched to.
    expect(await ServiceLineForms.switchTo(ADMIN, onc.id as string, db)).toEqual({ ok: false, message: "That service line is not available." });
  });

  it("a deleted line is restored from Audit as it was; a taken name or short name blocks it with a plain message", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    const onc = fake.addLine({ name: "Oncology Service Line", shortName: "ONC", archivedAt: new Date("2026-09-20T12:00:00Z") });
    await ServiceLineForms.remove(ADMIN, onc.id as string, "Oncology Service Line", db);
    // Listed on the Audit page.
    const audit = await AdminAuditService.load(ADMIN, db);
    expect(audit.deletedLines.map((l) => l.name)).toEqual(["Oncology Service Line"]);
    // Someone reuses the short name meanwhile: restore is refused, with a message the Audit page shows.
    const other = fake.addLine({ name: "Oncology Two", shortName: "ONC" });
    expect(await ServiceLineForms.restore(ADMIN, onc.id as string, db)).toMatchObject({ ok: false, message: ServiceLineCopy.RESTORE_CONFLICT });
    fake.state.serviceLines.find((l) => l.id === other.id)!.shortName = "ONC2";
    expect(await ServiceLineForms.restore(ADMIN, onc.id as string, db)).toEqual({ ok: true, message: "Restored." });
    const back = fake.state.serviceLines.find((l) => l.id === onc.id)!;
    expect(back).toMatchObject({ deletedAt: null, deletedBy: null });
    // It comes back as it was (here: archived), with its projects and settings untouched.
    expect(back.archivedAt).toEqual(new Date("2026-09-20T12:00:00Z"));
    expect((await AdminAuditService.load(ADMIN, db)).deletedLines).toEqual([]);
  });

  it("layout rules: shared admin table columns and the empty-line dashboard", () => {
    expect(ServiceLineTable.COLUMNS.map((c) => c.label)).toEqual([...ServiceLineCopy.COLUMNS, "Actions"]);
    expect(ServiceLineTable.COLUMNS.filter((c) => c.width === null).map((c) => c.key)).toEqual(["name"]);
    expect(DashboardViewModel.isEmptyLine({ isDefault: false }, 0, false)).toBe(true);
    expect(DashboardViewModel.isEmptyLine({ isDefault: false }, 1, false)).toBe(false);
    expect(DashboardViewModel.isEmptyLine({ isDefault: true }, 0, false)).toBe(false);
    expect(DashboardViewModel.isEmptyLine({ isDefault: false }, 0, true)).toBe(false);
    expect(DashboardViewModel.isEmptyLine(undefined, 0, false)).toBe(false);
  });

  it("non-admins always work in the default line (the seam for per-line access)", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    const onc = fake.addLine();
    fake.state.serviceLineUserState.push({ email: MEMBER.email, serviceLineId: onc.id, updatedAt: new Date() });
    expect((await ServiceLineAccess.activeFor(MEMBER, db)).id).toBe(ServiceLine.DEFAULT_ID);
    expect(await ServiceLineAccess.usableLines(MEMBER, db)).toEqual([]);
    expect(ServiceLineAccess.mayUse(MEMBER, onc as never)).toBe(false);
    expect(ServiceLineAccess.mayUse(ADMIN, onc as never)).toBe(true);
  });

  it("the switcher lists open lines only, default first then A to Z", async () => {
    const fake = new FakeDb();
    fake.addLine({ name: "Oncology Service Line", shortName: "ONC" });
    fake.addLine({ name: "Ambulatory Care", shortName: "AMB" });
    fake.addLine({ name: "Archived Line", shortName: "ARC", archivedAt: new Date() });
    fake.addLine({ name: "Deleted Line", shortName: "DEL", deletedAt: new Date() });
    expect((await ServiceLineAccess.usableLines(ADMIN, fake.asClient())).map((l) => l.shortName)).toEqual(["CVPSL", "AMB", "ONC"]);
  });
});

describe("report title and frozen snapshots", () => {
  const period1 = { periodStart: "2026-09-23", periodEnd: "2026-10-07", generatedBy: "nick", now: new Date("2026-10-07T10:00:00Z") };
  const period2 = { periodStart: "2026-10-07", periodEnd: "2026-10-21", generatedBy: "nick", now: new Date("2026-10-21T10:00:00Z") };

  it("a snapshot keeps the name it was frozen with after the setting changes", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = new FakeDb();
    const db = fake.asClient();
    await ProjectService.create({ name: "P", serviceArea: "Cath", owner: "O", status: "OnTrack", nextMilestone: "M" }, { changedBy: "x" }, db);

    const s1 = await SnapshotService.create(period1, db);
    expect(s1.serviceLineJson).toEqual(SEED);

    await ServiceLineService.update(ServiceLine.DEFAULT_ID, { name: "Heart and Vascular Service Line", shortName: "HVSL" }, ADMIN, db);
    const s2 = await SnapshotService.create(period2, db);

    const in1 = PdfReportRenderer.inputFromSnapshot(fake.state.snapshots.find((s) => s.id === s1.id) as never);
    const in2 = PdfReportRenderer.inputFromSnapshot(s2);
    expect(in1.serviceLine).toEqual(SEED);
    expect(in2.serviceLine).toEqual({ name: "Heart and Vascular Service Line", shortName: "HVSL" });

    const m = new TextMeasure();
    const l1 = ReportLayout.layout(PdfReportRenderer.docInput(in1), m);
    const l2 = ReportLayout.layout(PdfReportRenderer.docInput(in2), m);
    expect(l1.header.overline?.lines).toEqual(["CARDIOVASCULAR & PULMONARY SERVICE LINE"]);
    expect(l1.header.runningTitle).toBe("CVPSL \u00b7 Project Status Report");
    expect(l2.header.overline?.lines).toEqual(["HEART AND VASCULAR SERVICE LINE"]);
    expect(l2.header.runningTitle).toBe("HVSL \u00b7 Project Status Report");
    vi.restoreAllMocks();
  });

  it("snapshots frozen before migration 0014 (no serviceLineJson, no short name) keep the legacy header", () => {
    expect(ServiceLine.fromSnapshot(null)).toBeNull();
    expect(ServiceLine.fromSnapshot(undefined)).toBeNull();
    const input = PdfReportRenderer.inputFromSnapshot({
      id: "old",
      rowsJson: [],
      headerJson: null,
      completedJson: null,
      viewSettingsJson: null,
      optionsJson: null,
      serviceLineJson: null,
      periodStart: new Date("2026-08-26T00:00:00Z"),
      periodEnd: new Date("2026-09-09T00:00:00Z"),
      generatedAt: new Date("2026-09-09T21:00:00Z"),
    });
    const doc = PdfReportRenderer.docInput(input);
    expect(doc.serviceLine).toBeNull();
    const h = ReportLayout.layout(doc, new TextMeasure()).header;
    // Exactly what those reports drew: one combined line on page 1 and in the running header and footer.
    expect(h.overline).toBeNull();
    expect(h.title).toBe("Cardiac Service Line: Project Status Report");
    expect(h.runningTitle).toBe("Cardiac Service Line: Project Status Report");
    expect(h.footerLeft).toContain("Cardiac Service Line: Project Status Report");
    expect(h.titleBarHeight).toBe(ReportGeometry.TITLE_BAR_H);
    expect(PdfReportLayout.title(input.serviceLine?.name)).toBe("Cardiac Service Line: Project Status Report");
    expect(ServiceLine.metadataTitle(null)).toBe("Cardiac Service Line: Project Status Report");
  });
});

describe("PDF header (Figma spec: overline, title line, short-name running header)", () => {
  const m = new TextMeasure();
  const G = ReportGeometry;
  const LONGEST = "Cardiovascular Thoracic, Pulmonary and Vascular Surgery & Interventional Service"; // 80 chars
  const WIDEST = "W".repeat(ServiceLine.NAME_MAX_LENGTH);

  it("page 1 draws the name as an 8 pt uppercase overline and 'Project Status Report' as its own title line", () => {
    const h = ReportLayout.layout(SampleReportData.docInput({ serviceLine: SEED }), m).header;
    expect(h.overline).toEqual({ lines: ["CARDIOVASCULAR & PULMONARY SERVICE LINE"], size: 8, tracking: G.OVERLINE.tracking });
    expect(h.title).toBe("Project Status Report");
    expect(h.title).not.toContain(SEED.name);
    expect(h.titleBarHeight).toBe(G.TITLE_BAR_H + G.OVERLINE.lineH + G.OVERLINE.gap);
  });

  it("pages 2+ lead the running header with the short name, and the footer uses the same short form", () => {
    const layout = ReportLayout.layout(SampleReportData.docInput({ serviceLine: SEED }), m);
    expect(layout.pages.length).toBeGreaterThan(1);
    expect(layout.header.runningTitle).toBe("CVPSL \u00b7 Project Status Report");
    expect(layout.header.footerLeft).toContain("\u00b7 CVPSL \u00b7 Project Status Report");
    expect(layout.header.footerLeft).not.toContain(": Project Status Report");
  });

  it("the combined one-line title is kept only for PDF metadata and handoff.json", () => {
    expect(PdfReportLayout.title(SEED.name)).toBe("Cardiovascular & Pulmonary Service Line: Project Status Report");
    expect(ServiceLine.metadataTitle(SEED)).toBe("Cardiovascular & Pulmonary Service Line: Project Status Report");
  });

  it("the longest allowed name (80 chars) fits on one line at 8 pt, even beside the EXAMPLE DATA or DRAFT badge", () => {
    expect(LONGEST).toHaveLength(80);
    for (const extra of [{}, { draft: true }, { exampleData: true }, { exampleData: false }]) {
      const h = ReportLayout.layout(SampleReportData.docInput({ serviceLine: { name: LONGEST, shortName: "CTPVS" }, ...extra }), m).header;
      expect(h.overline?.lines).toEqual([LONGEST.toUpperCase()]);
      expect(h.overline?.size).toBe(8);
      expect(ReportLayout.overlineWidth(m, LONGEST.toUpperCase(), 8)).toBeLessThanOrEqual(ReportLayout.overlineMaxWidth(m, h.badge));
    }
  });

  it("a pathological 80-char name shrinks, then wraps within the width, and page 1 grows to fit", () => {
    const h = ReportLayout.overline(m, WIDEST, "EXAMPLE DATA");
    const maxW = ReportLayout.overlineMaxWidth(m, "EXAMPLE DATA");
    expect(h.size).toBeGreaterThanOrEqual(G.OVERLINE.minSize);
    expect(h.size).toBeLessThan(8);
    expect(h.lines.length).toBeLessThanOrEqual(G.OVERLINE.maxLines);
    for (const line of h.lines) expect(ReportLayout.overlineWidth(m, line, h.size)).toBeLessThanOrEqual(maxW);
    const spaced = ReportLayout.overline(m, Array.from({ length: 16 }, () => "WWWW").join(" "), "EXAMPLE DATA");
    for (const line of spaced.lines) expect(ReportLayout.overlineWidth(m, line, spaced.size)).toBeLessThanOrEqual(maxW);
    const input = SampleReportData.docInput({ serviceLine: { name: WIDEST, shortName: "W" } });
    const layout = ReportLayout.layout(input, m);
    expect(layout.pages[0].headerHeight).toBe(ReportLayout.firstHeaderHeight(input, layout.header));
  });

  it("handoff.json title follows the frozen name", () => {
    const h = HandoffBuilder.build({
      snapshotId: "s",
      periodStart: "2026-09-15",
      periodEnd: "2026-09-29",
      reportDate: "2026-09-29",
      frozenAt: new Date("2026-09-29T21:00:00Z"),
      rows: [],
      header: null,
      pdf: { fileName: "r.pdf", sha256: "x", byteSize: 1 },
      baseUrl: null,
      reportRecipient: null,
      serviceLineName: "Heart",
    });
    expect(h.title).toBe("Heart: Project Status Report");
  });
});

describe("ServiceLineLabel (responsive top bar name)", () => {
  const html = renderToStaticMarkup(createElement(ServiceLineLabel, { value: SEED }));

  it("renders the full name (visible from the topbar breakpoint up, screen-reader text below it)", () => {
    expect(html).toContain('class="sr-only topbar:not-sr-only topbar:block topbar:whitespace-nowrap" data-service-line-full="">Cardiovascular &amp; Pulmonary Service Line</span>');
  });

  it("renders the short name below the breakpoint with the full name as its tooltip", () => {
    expect(html).toContain('<span aria-hidden="true" title="Cardiovascular &amp; Pulmonary Service Line" class="topbar:hidden" data-service-line-short="">CVPSL</span>');
  });
});
