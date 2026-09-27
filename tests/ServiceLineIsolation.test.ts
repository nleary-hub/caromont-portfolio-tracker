import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "csv-stringify/sync";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient, ReportSnapshot } from "@/generated/prisma/client";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { DashboardPrefs, type PrefsStorage } from "@/lib/dashboard/DashboardPrefs";
import { ServiceLineSwitch } from "@/lib/dashboard/ServiceLineSwitch";
import { ContractsLead } from "@/lib/domain/ContractsLead";
import { ServiceLine, type ServiceLineScope } from "@/lib/domain/ServiceLine";
import { ExportService } from "@/lib/import/ExportService";
import { ImportService } from "@/lib/import/ImportService";
import { ProjectCsv } from "@/lib/import/ProjectCsv";
import { PdfReportRenderer } from "@/lib/report/PdfReportRenderer";
import { ReportDataLoader } from "@/lib/report/ReportDataLoader";
import { ServiceLineDrive, ServiceLineDriveError } from "@/lib/report/ServiceLineDrive";
import { ReportLayout } from "@/lib/report/pdf/ReportLayout";
import { AdminAuditService } from "@/lib/services/AdminAuditService";
import { DraftReportService } from "@/lib/services/DraftReportService";
import { FreezeService } from "@/lib/services/FreezeService";
import { MilestoneTemplateService } from "@/lib/services/MilestoneTemplateService";
import { ProjectNotFoundError, ProjectService } from "@/lib/services/ProjectService";
import { ReportDeliveryService } from "@/lib/services/ReportDeliveryService";
import { Factory } from "./helpers/factories";
import { FakeDb } from "./helpers/FakeDb";

const ADMIN = Factory.ADMIN;
const actor = { changedBy: ADMIN.email };
const CVPSL = ServiceLine.defaultScope();
const NOW = new Date("2026-09-26T16:00:00Z");

class Lines {
  static onc(fake: FakeDb, overrides: Record<string, unknown> = {}): ServiceLineScope {
    const row = fake.addLine({ departments: ["Cath", "IR"], contractsLeads: ["Pat Contracts"], ...overrides });
    return ServiceLineAccess.toScope(row as never);
  }

  static csv(rows: Record<string, string>[]): string {
    const cols = ProjectCsv.TEMPLATE_COLUMNS as readonly string[];
    const full = rows.map((r) => ({ ...Object.fromEntries(cols.map((c) => [c, ""])), ...r }));
    return stringify([cols as string[], ...full.map((r) => cols.map((c) => r[c] ?? ""))], { record_delimiter: "\n" });
  }

  static memoryStorage(): PrefsStorage & { data: Map<string, string> } {
    const data = new Map<string, string>();
    return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) } as never;
  }

  static files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? Lines.files(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
    });
  }
}

describe("service line isolation", () => {
  let fake: FakeDb;
  let db: PrismaClient;
  let onc: ServiceLineScope;
  beforeEach(async () => {
    fake = new FakeDb();
    db = fake.asClient();
    onc = Lines.onc(fake);
    await ProjectService.create({ name: "CVPSL project", serviceArea: "EP", owner: "Owner A", status: "OnTrack", nextMilestone: "M1" }, actor, db);
    await ProjectService.create({ name: "Oncology project", serviceArea: "IR", owner: "Owner O", status: "AtRisk", nextMilestone: "M2" }, actor, db, onc);
  });

  it("projects: each line sees and edits only its own projects", async () => {
    const [cv, on] = fake.state.projects;
    expect(cv.serviceLineId ?? ServiceLine.DEFAULT_ID).toBe(ServiceLine.DEFAULT_ID);
    expect(on.serviceLineId).toBe(onc.id);
    await expect(ProjectService.update(cv.id as string, { note: "x" }, actor, db, onc)).rejects.toThrow(ProjectNotFoundError);
    await expect(ProjectService.update(on.id as string, { note: "x" }, actor, db)).rejects.toThrow(ProjectNotFoundError);
    await expect(ProjectService.softDelete(cv.id as string, ADMIN, db, undefined, onc)).rejects.toThrow(ProjectNotFoundError);
    await ProjectService.update(on.id as string, { note: "Scoped edit" }, actor, db, onc);
    expect(fake.state.projects[1].note).toBe("Scoped edit");
  });

  it("projects: a new line only accepts its own departments", async () => {
    await expect(
      ProjectService.create({ name: "Wrong dept", serviceArea: "EP", owner: "Owner O", status: "OnTrack", nextMilestone: "M" }, actor, db, onc),
    ).rejects.toThrow();
    expect(fake.state.projects.map((p) => p.name)).toEqual(["CVPSL project", "Oncology project"]);
  });

  it("templates: lists, edits and history are per line", async () => {
    await MilestoneTemplateService.create("Onc template", ADMIN, db, onc);
    const cvList = await MilestoneTemplateService.list(db);
    const oncList = await MilestoneTemplateService.list(db, onc);
    expect(oncList.map((t) => t.name)).toEqual(["Onc template"]);
    expect(cvList.map((t) => t.name)).not.toContain("Onc template");
    await expect(MilestoneTemplateService.rename(oncList[0].id, "Stolen", ADMIN, db)).rejects.toThrow();
    expect((await MilestoneTemplateService.history(ADMIN, 20, db)).some((h) => JSON.stringify(h).includes("Onc template"))).toBe(false);
    expect((await MilestoneTemplateService.history(ADMIN, 20, db, onc)).length).toBeGreaterThan(0);
  });

  it("people: CVPSL keeps its owner seed and contracts leads; a new line starts empty with its own leads", () => {
    expect(ServiceLineAccess.ownerSeed(CVPSL, ["Nicole Smith", "Nick Leary"])).toEqual(["Nicole Smith", "Nick Leary"]);
    expect(ServiceLineAccess.ownerSeed(onc, ["Nicole Smith", "Nick Leary"])).toEqual([]);
    expect(ContractsLead.resolve("Pat Contracts", onc.contractsLeads)).toBe("Pat Contracts");
    expect(ContractsLead.resolve("Pat Contracts")).toBeUndefined();
    expect(ContractsLead.resolve("Shea Waldron", onc.contractsLeads)).toBeUndefined();
    expect(ContractsLead.invalidMessage("Shea Waldron", [])).toContain("no contracts leads yet");
    expect(ContractsLead.resolve("Shea Waldron")).toBe("Shea Waldron");
  });

  it("PDF: the report data and layout for a line include only its projects and departments", async () => {
    const cv = await ReportDataLoader.load(db, NOW);
    const on = await ReportDataLoader.load(db, NOW, onc);
    expect(cv.rows.map((r) => r.name)).toEqual(["CVPSL project"]);
    expect(on.rows.map((r) => r.name)).toEqual(["Oncology project"]);
    expect(on.serviceLine).toMatchObject({ name: onc.name, shortName: "ONC" });
    expect(ReportLayout.gridAreas(on.rows, undefined, onc.departments).filter((a) => a !== "Unassigned")).toEqual(["Cath", "IR"]);
    expect(ReportLayout.gridAreas(cv.rows).filter((a) => a !== "Unassigned")).toEqual(["Cath", "EP", "Echo", "CVSS", "INU", "CardioNeuro", "IR"]);
    const layout = JSON.stringify(ReportLayout.layout({ ...on, lineDepartments: onc.departments, periodStart: "2026-09-15", periodEnd: "2026-09-29", generatedAt: NOW, draft: true }));
    expect(layout).toContain("Oncology project");
    expect(layout).not.toContain("CVPSL project");
    await ServiceLineAccess.setActive(ADMIN, onc.id, db);
    const draft = await DraftReportService.render(ADMIN, db, NOW);
    expect(draft!.fileName).toBe(PdfReportRenderer.lineDraftFileName("ONC", "2026-09-26"));
    expect(fake.state.snapshots).toHaveLength(0);
  });

  it("audit log: a line shows only its own projects' history and line events", async () => {
    const [cvp, onp] = fake.state.projects;
    await ProjectService.setHidden(cvp.id as string, "report", true, ADMIN, db);
    await ProjectService.setHidden(onp.id as string, "report", true, ADMIN, db, onc);
    await expect(ProjectService.setHidden(cvp.id as string, "dashboard", true, ADMIN, db, onc)).rejects.toThrow(ProjectNotFoundError);
    const cv = await AdminAuditService.load(ADMIN, db);
    const on = await AdminAuditService.load(ADMIN, db, onc);
    const cvText = JSON.stringify(cv.events);
    const onText = JSON.stringify(on.events);
    expect(cvText).toContain("CVPSL project");
    expect(cvText).not.toContain("Oncology project");
    expect(onText).toContain("Oncology project");
    expect(onText).not.toContain("CVPSL project");
    expect(cv.hidden.map((p) => p.name)).toEqual(["CVPSL project"]);
    expect(on.hidden.map((p) => p.name)).toEqual(["Oncology project"]);
  });

  it("import and export are per line", async () => {
    expect((await ExportService.exportCsv(db)).csv).toContain("CVPSL project");
    expect((await ExportService.exportCsv(db)).csv).not.toContain("Oncology project");
    expect((await ExportService.exportCsv(db, onc)).csv).not.toContain("CVPSL project");
    const csv = Lines.csv([{ name: "Imported onc", service_area: "Cath", owner: "Owner O", status: "OnTrack", next_milestone: "M" }]);
    const bad = Lines.csv([{ name: "Imported onc EP", service_area: "EP", owner: "Owner O", status: "OnTrack", next_milestone: "M" }]);
    expect((await ImportService.previewCreate(bad, db, onc)).canCommit).toBe(false);
    await ImportService.commitCreate(csv, ADMIN.email, db, onc);
    const imported = fake.state.projects.find((p) => p.name === "Imported onc")!;
    expect(imported.serviceLineId).toBe(onc.id);
    expect((await ExportService.exportCsv(db)).csv).not.toContain("Imported onc");
  });

  it("dashboard prefs: CVPSL keys are unchanged; other lines get their own keys and department options", () => {
    const email = "a@example.org";
    expect(DashboardPrefs.departmentsKey(email, CVPSL)).toBe(DashboardPrefs.departmentsKey(email));
    expect(DashboardPrefs.hiddenTilesKey(email, CVPSL)).toBe(DashboardPrefs.hiddenTilesKey(email));
    expect(DashboardPrefs.departmentsKey(email, onc)).toBe(`${DashboardPrefs.departmentsKey(email)}:sl:${onc.id}`);
    expect(DashboardPrefs.options(onc)).toEqual(["Cath", "IR"]);
    const storage = Lines.memoryStorage();
    DashboardPrefs.writeDepartments(storage, email, ["IR"], onc);
    expect(DashboardPrefs.readDepartments(storage, email, onc)).toEqual(["IR"]);
    expect(DashboardPrefs.readDepartments(storage, email)).toEqual(DashboardPrefs.readDepartments(null, email));
  });

  it("Drive: only the default line may use the root folder; delivery for another line throws before any Drive call", async () => {
    expect(ServiceLineDrive.usesRootFolder(CVPSL)).toBe(true);
    expect(ServiceLineDrive.subfolderPath(CVPSL)).toBeNull();
    expect(ServiceLineDrive.subfolderPath(onc)).toEqual(["Service lines", "ONC"]);
    const fetchSpy = vi.fn();
    fake.writes.length = 0;
    const file = { fileName: "x", contentType: "application/pdf", bytes: Buffer.from("x") } as never;
    await expect(ReportDeliveryService.deliver("s1", { pdf: file, handoff: file }, "test", { fetch: fetchSpy, env: {} }, db, onc)).rejects.toThrow(ServiceLineDriveError);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fake.writes).toHaveLength(0);
  });

  it("the scheduled freeze steps refuse a snapshot from another line", async () => {
    const snap = { id: "s-onc", serviceLineId: onc.id } as unknown as ReportSnapshot;
    fake.writes.length = 0;
    await expect(FreezeService.complete(snap, { env: {} } as never, db)).rejects.toThrow(/default service line only/);
    expect(fake.writes).toHaveLength(0);
  });

  it("switching keeps line pages and sends others home", () => {
    expect(ServiceLineSwitch.destination("/reports")).toBe("/reports");
    expect(ServiceLineSwitch.destination("/admin/templates")).toBe("/admin/templates");
    expect(ServiceLineSwitch.destination("/admin/users")).toBe("/");
    expect(ServiceLineSwitch.destination(null)).toBe("/");
  });

  it("every server action and line page resolves the service line explicitly", () => {
    const root = join(process.cwd(), "src/app");
    const actions = Lines.files(join(root, "actions")).filter((f) => !/auth|signin/i.test(f));
    const pages = ["page.tsx", "reports/page.tsx", "admin/import/page.tsx", "admin/import/actions.ts", "admin/import/export/route.ts", "admin/templates/page.tsx", "admin/settings/page.tsx", "admin/audit/page.tsx", "admin/service-lines/page.tsx", "reports/[id]/[file]/route.ts"].map((p) => join(root, p));
    const missing = [...actions, ...pages].filter((f) => {
      const src = readFileSync(f, "utf8");
      return !/ServiceLineAccess|ServiceLineForms|ImportActionsSupport|AdminAction|ProjectFormAction/.test(src);
    });
    expect(missing).toEqual([]);
  });
});
