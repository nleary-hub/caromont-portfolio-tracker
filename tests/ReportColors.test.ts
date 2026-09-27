import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReportColorScheme } from "@/lib/report/ReportColorScheme";
import { ReportColors } from "@/lib/report/pdf/ReportDocument";
import { PdfReportRenderer } from "@/lib/report/PdfReportRenderer";
import { AdminAuditService } from "@/lib/services/AdminAuditService";
import { FreezeService, type FreezeOptions } from "@/lib/services/FreezeService";
import { ProjectService } from "@/lib/services/ProjectService";
import { ReportColorsForm } from "@/lib/services/ReportOptionsForm";
import { ReportOptionsService } from "@/lib/services/ReportOptionsService";
import { Factory } from "./helpers/factories";
import { FakeDb } from "./helpers/FakeDb";

const S = ReportColorScheme;
const ROOT = path.resolve(__dirname, "..");
const src = (p: string) => readFileSync(path.join(ROOT, p), "utf8");
const form = (bar: string, band = "none", barHex = "", bandHex = "") => ({ bar, barHex, band, bandHex });

afterEach(() => vi.restoreAllMocks());

describe("ReportColorScheme: defaults, presets and contrast", () => {
  it("defaults to navy solid bars and no header band", () => {
    expect(S.DEFAULTS).toEqual({ bar: "navy", band: "none" });
    const r = S.resolve(null);
    expect(r.bar).toEqual({ fill: "#1F3A5F", text: "#FFFFFF", stripe: "#1F3A5F", count: "#FFFFFF", unassigned: "#D0D8E4" });
    expect(r.band).toBeNull();
    expect(ReportOptionsService.defaults().colors).toEqual(S.DEFAULTS);
  });

  it("the two controls are independent: navy bars with a plum header band", () => {
    const r = S.resolve({ bar: "navy", band: "plum" });
    expect(r.bar.fill).toBe("#1F3A5F");
    expect(r.band).toEqual(S.PRESETS.plum.band);
  });

  it("every preset meets AA (4.5:1) for the department name and the project count, and for the band text", () => {
    for (const k of S.PRESET_KEYS) {
      const { bar, band } = S.PRESETS[k];
      expect(S.contrast(bar.text, bar.fill), `${k} name`).toBeGreaterThanOrEqual(4.5);
      expect(S.contrast(bar.count, bar.fill), `${k} count`).toBeGreaterThanOrEqual(4.5);
      expect(S.passes(bar), k).toBe(true);
      expect(S.bandPasses(band), k).toBe(true);
    }
  });

  it("custom text is white or near-black, whichever contrasts more", () => {
    expect(S.derive("#2B4C7E").bar.text).toBe("#FFFFFF");
    expect(S.derive("#FFD700").bar.text).toBe("#15171C");
    expect(S.derive("#808080").bar.text).toBe("#15171C");
    for (const c of ["#2B4C7E", "#FFD700", "#E1E5EB", "#808080", "#000000", "#FFFFFF"]) {
      const d = S.derive(c);
      expect(S.passes(d.bar), c).toBe(true);
      expect(S.bandPasses(d.band), c).toBe(true);
    }
  });

  it("blocks a custom color whose text would fall below 4.5:1, and a malformed one", () => {
    expect(S.contrast("#FFFFFF", "#777777")).toBeLessThan(4.5);
    expect(S.contrast("#15171C", "#777777")).toBeLessThan(4.5);
    expect(S.check("#777777")).toEqual({ ok: false, message: S.COPY.tooLowContrast });
    expect(S.check("#12345")).toEqual({ ok: false, message: S.COPY.invalid });
    expect(S.check("navy")).toEqual({ ok: true });
  });

  it("warns (without blocking) when a custom color is within CIEDE2000 5 of a status color; presets never warn", () => {
    expect(S.STATUS_DISTANCE).toBe(5);
    // Status colors as drawn in the PDF (ReportColors).
    expect(S.STATUS_COLORS.map((c) => c.hex)).toEqual([ReportColors.STATUS.Complete.bg, ReportColors.STATUS.Complete.fg, ReportColors.STATUS.OnHold.bg, ReportColors.STATUS.OnHold.fg, ReportColors.CHANGED.fg]);
    expect(S.distance("#1F3A5F", "#1F3A5F")).toBe(0);
    expect(S.nearStatus("#2B4C7E")?.name).toBe("On hold");
    expect(S.nearStatus("#0F6A62")?.name).toBe("Completed");
    expect(S.nearStatus("#4A2FA0")?.name).toBe("Changed");
    expect(S.nearStatus("#FFD700")).toBeNull();
    expect(S.check("#2B4C7E")).toEqual({ ok: true });
    for (const k of S.PRESET_KEYS) {
      expect(S.nearStatus(k)).toBeNull();
      for (const ref of S.STATUS_COLORS) expect(S.distance(S.PRESETS[k].bar.fill, ref.hex), `${k} vs ${ref.name}`).toBeGreaterThanOrEqual(S.STATUS_DISTANCE);
    }
  });

  it("labels for Recent changes", () => {
    expect(S.label("navy")).toBe("Navy solid");
    expect(S.label("deeper-plum")).toBe("Deeper plum");
    expect(S.label("none")).toBe("None");
    expect(S.label("#2B4C7E")).toBe("Custom #2B4C7E");
  });

  it("UI copy has no em dashes", () => {
    for (const v of Object.values(S.COPY)) expect(v).not.toMatch(/\u2014/);
    for (const k of S.PRESET_KEYS) expect(S.PRESETS[k].label).not.toMatch(/\u2014/);
    expect(src("src/components/ReportColorsForm.tsx")).not.toMatch(/\u2014/);
  });
});

describe("ReportColorsForm (Admin > Report contents > Report colors)", () => {
  it("parses presets, None and custom colors; blocks low contrast and bad input", () => {
    expect(ReportColorsForm.parse(form("navy", "plum"))).toEqual({ ok: true, value: { bar: "navy", band: "plum" } });
    expect(ReportColorsForm.parse(form("custom", "custom", "#2b4c7e", "FFD700"))).toEqual({ ok: true, value: { bar: "#2B4C7E", band: "#FFD700" } });
    expect(ReportColorsForm.parse(form("custom", "none", "#777777"))).toEqual({ ok: false, message: S.COPY.tooLowContrast, field: "bar" });
    expect(ReportColorsForm.parse(form("navy", "custom", "", "#777777"))).toEqual({ ok: false, message: S.COPY.tooLowContrast, field: "band" });
    expect(ReportColorsForm.parse(form("custom", "none", "blue"))).toEqual({ ok: false, message: S.COPY.invalid, field: "bar" });
    expect(ReportColorsForm.parse(form("none"))).toEqual({ ok: false, message: S.COPY.invalid, field: "bar" });
  });

  it("is admin-only", async () => {
    const fake = new FakeDb();
    expect(await ReportColorsForm.submit(Factory.MEMBER, form("plum"), fake.asClient())).toEqual({ ok: false, message: "Not authorized." });
    expect(await ReportColorsForm.submit(null, form("plum"), fake.asClient())).toEqual({ ok: false, message: "Not authorized." });
    expect(fake.state.reportOptionsHistory).toHaveLength(0);
    expect(fake.state.reportOptions).toHaveLength(0);
  });

  it("a blocked color writes nothing", async () => {
    const fake = new FakeDb();
    expect(await ReportColorsForm.submit(Factory.ADMIN, form("custom", "none", "#777777"), fake.asClient())).toEqual({ ok: false, message: S.COPY.tooLowContrast, field: "bar" });
    expect(fake.state.reportOptionsHistory).toHaveLength(0);
  });

  it("saves the row columns and one history row; Recent changes shows Bar color changed / Header band changed with OLD and NEW", async () => {
    const fake = new FakeDb();
    const db = fake.asClient();
    const p = await ProjectService.create({ serviceArea: "Cath", owner: "Owner A", status: "OnTrack", nextMilestone: "M1", name: "Alpha" }, { changedBy: "editor@example.org" }, db);
    const historyBefore = fake.state.history.length;
    const res = await ReportColorsForm.submit(Factory.ADMIN, form("navy", "plum"), db);
    expect(res).toEqual({ ok: true, message: S.COPY.saved, value: { bar: "navy", band: "plum" } });
    expect(fake.state.reportOptions[0]).toMatchObject({ barColor: "navy", headerBand: "plum" });
    expect(fake.state.reportOptionsHistory).toHaveLength(1);
    expect(fake.state.reportOptionsHistory[0].oldValue).toMatchObject({ colors: { bar: "navy", band: "none" } });
    expect(fake.state.reportOptionsHistory[0].newValue).toMatchObject({ colors: { bar: "navy", band: "plum" } });
    // Saving the same colors again is a no-op (no second audit row).
    await ReportColorsForm.submit(Factory.ADMIN, form("navy", "plum"), db);
    expect(fake.state.reportOptionsHistory).toHaveLength(1);
    fake.state.reportOptionsHistory[0].changedAt = new Date("2026-09-27T21:00:00Z");
    await ReportColorsForm.submit(Factory.ADMIN, form("custom", "plum", "#FFD700"), db);
    fake.state.reportOptionsHistory[1].changedAt = new Date("2026-09-27T21:05:00Z");
    // No project history, so Changed and Stale (computed from project history) cannot move.
    expect(fake.state.history).toHaveLength(historyBefore);
    expect(fake.state.projects.find((x) => x.id === p.id)).toBeTruthy();

    const audit = await AdminAuditService.load(Factory.ADMIN, db);
    const rows = audit.events.filter((e) => e.kind === "reportColors").map((e) => [e.subject, e.field, e.oldValue, e.newValue]);
    expect(rows).toEqual([
      ["Report colors", AdminAuditService.COLOR_FIELDS.bar, "Navy solid", "Custom #FFD700"],
      ["Report colors", AdminAuditService.COLOR_FIELDS.band, "None", "Plum"],
    ]);
    expect(src("src/app/admin/audit/page.tsx")).toContain("ReportColorScheme.COPY.auditBand : ReportColorScheme.COPY.auditBar");
    expect([S.COPY.auditBar, S.COPY.auditBand]).toEqual(["Bar color changed", "Header band changed"]);
  });

  it("other report option changes and history rows from before 0027 add no color rows", () => {
    const at = new Date();
    const base = { changedAt: at, changedBy: "x" };
    expect(AdminAuditService.colorEvents({ ...base, oldValue: { showKeyPage: true }, newValue: { showKeyPage: false } })).toEqual([]);
    expect(AdminAuditService.colorEvents({ ...base, oldValue: { showKeyPage: true, colors: S.DEFAULTS }, newValue: { showKeyPage: false, colors: S.DEFAULTS } })).toEqual([]);
  });
});

describe("stored values and frozen reports", () => {
  it("old history rows and snapshots without colors read as the defaults (settings) / classic look (frozen)", () => {
    expect(ReportOptionsService.normalize({ showKeyPage: false }).colors).toEqual({ bar: "navy", band: "none" });
    expect(ReportOptionsService.normalize({ colors: { bar: "chartreuse", band: 7 } }).colors).toEqual({ bar: "navy", band: "none" });
    expect(ReportOptionsService.normalize({ colors: { bar: "#777777", band: "#2b4c7e" } }).colors).toEqual({ bar: "navy", band: "#2B4C7E" });
    expect(S.frozen(undefined)).toEqual({ bar: "classic", band: "none" });
    expect(S.frozen({ bar: "plum", band: "navy" })).toEqual({ bar: "plum", band: "navy" });
    expect(S.resolve(S.frozen(undefined)).bar).toEqual({ fill: ReportColors.SECTION_BG_STRONG, text: ReportColors.TEXT, stripe: ReportColors.TEXT, count: ReportColors.MUTED, unassigned: ReportColors.MUTED });
  });

  it("a re-render of a snapshot frozen before 0027 keeps its light gray bars; a new one keeps the colors it was frozen with", () => {
    const snap = (optionsJson: unknown) =>
      PdfReportRenderer.inputFromSnapshot({
        id: "s1",
        rowsJson: [],
        headerJson: null,
        completedJson: null,
        viewSettingsJson: null,
        optionsJson,
        serviceLineJson: null,
        periodStart: new Date("2026-09-15T00:00:00Z"),
        periodEnd: new Date("2026-09-29T00:00:00Z"),
        generatedAt: new Date("2026-09-29T21:00:00Z"),
      } as never);
    expect(snap({ showKeyPage: true, excludedDepartments: [], totalsGrid: "top" }).options.colors).toEqual({ bar: "classic", band: "none" });
    expect(snap({ showKeyPage: true, excludedDepartments: [], totalsGrid: "top", colors: { bar: "deeper-plum", band: "navy" } }).options.colors).toEqual({ bar: "deeper-plum", band: "navy" });
  });

  it("a freeze stores the colors in optionsJson; Changed/Stale flags and handoff.json are the same as without the change", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const ENV = { SHARE_LINK_SECRET: "x".repeat(48), APP_BASE_URL: "https://tracker.example.org/", REPORT_RECIPIENT_EMAIL: "you@example.org" };
    const opts: FreezeOptions = { trigger: "cron", actor: "cron", env: ENV, now: new Date("2026-09-29T21:00:00Z"), fetch: vi.fn() };
    const setup = async (colors: boolean) => {
      const fake = new FakeDb();
      const db = fake.asClient();
      const actor = { changedBy: "nick.leary@example.org" };
      await ProjectService.create({ serviceArea: "Cath", owner: "Owner A", status: "OnTrack", nextMilestone: "M1", name: "Late", dueDate: "2026-09-20" }, actor, db);
      await ProjectService.create({ serviceArea: "EP", owner: "Owner A", status: "OnHold", nextMilestone: "M1", name: "Held" }, actor, db);
      if (colors) await ReportColorsForm.submit(Factory.ADMIN, form("deeper-plum", "navy"), db);
      await FreezeService.run(opts, db);
      return fake;
    };
    const [plain, colored] = [await setup(false), await setup(true)];
    const flags = (f: FakeDb) => (f.state.snapshots[0].rowsJson as { name: string; changed: boolean; stale?: boolean; overdue: boolean }[]).map((r) => [r.name, r.changed, Boolean(r.stale), r.overdue]);
    expect(flags(colored)).toEqual(flags(plain));
    expect(plain.state.snapshots[0].optionsJson).toMatchObject({ colors: { bar: "navy", band: "none" } });
    expect(colored.state.snapshots[0].optionsJson).toMatchObject({ colors: { bar: "deeper-plum", band: "navy" } });
    const handoff = (f: FakeDb) => {
      const a = f.state.artifacts.find((x) => x.kind === "handoff")!;
      return Buffer.from(a.bytes as Uint8Array).toString("utf8");
    };
    expect(handoff(colored)).not.toMatch(/color|plum|navy/i);
    const ids = (s: string) => s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "ID").replace(/"(snapshotId|id)":"[^"]*"/g, '"$1":"ID"')
        // The PDF's own hash and size differ (its bars are drawn in other colors); everything else is identical.
        .replace(/"sha256": "[0-9a-f]{64}"/g, '"sha256": "PDF"')
        .replace(/"byteSize": \d+/g, '"byteSize": 0');
    expect(ids(handoff(colored))).toBe(ids(handoff(plain)));
  });

  it("the PDF draws bars and the band from the palette (Year-end is unchanged)", () => {
    const doc = src("src/lib/report/pdf/ReportDocument.tsx");
    expect(doc).toContain("backgroundColor: bar.fill");
    expect(doc).toContain("color={bar.count}");
    expect(doc).toContain("backgroundColor: band.fill");
    expect(src("src/lib/report/pdf/YearEndDocument.tsx")).toContain("C.SECTION_BG_STRONG");
    expect(src("src/lib/report/pdf/ReportLayout.ts")).not.toMatch(/doc\.colors|input\.colors/);
  });
});

const DIR = path.join(ROOT, "prisma/migrations");
const M = "0027_report_colors";
const FIXTURE = readFileSync(path.join(ROOT, "tests/fixtures/prod-shape-0015.sql"), "utf8");

class M27 {
  static folders(): string[] {
    return readdirSync(DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  }

  static sql(folder: string = M): string {
    return readFileSync(path.join(DIR, folder, "migration.sql"), "utf8");
  }

  static async before(): Promise<PGlite> {
    const db = await PGlite.create();
    for (const f of M27.folders()) {
      if (f === "0016_service_lines") break;
      await db.exec(M27.sql(f));
    }
    await db.exec(FIXTURE);
    for (const f of M27.folders().filter((x) => x >= "0016" && x < M)) await db.exec(M27.sql(f));
    return db;
  }

  static async columns(db: PGlite): Promise<Record<string, string[]>> {
    const t = await db.query<{ t: string }>(`select table_name as t from information_schema.tables where table_schema = 'public' order by 1`);
    const out: Record<string, string[]> = {};
    for (const { t: name } of t.rows) {
      const r = await db.query<{ c: string }>(`select column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '') as c from information_schema.columns where table_schema = 'public' and table_name = $1 order by ordinal_position`, [name]);
      out[name] = r.rows.map((x) => x.c);
    }
    return out;
  }

  static async snapshot(db: PGlite, tables: string[], except: string[] = []): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const t of tables.filter((x) => !except.includes(x))) {
      const r = await db.query<{ md5: string }>(`select coalesce(md5(string_agg(md5(s::text), '|' order by md5(s::text))), '') as md5 from "${t}" s`);
      out[t] = r.rows[0].md5;
    }
    return out;
  }

  static downSteps(): string[] {
    return M27.sql()
      .split("\n")
      .filter((l) => /^--\s+(ALTER TABLE|DELETE FROM)\s/.test(l))
      .map((l) => l.replace(/^--\s+/, ""));
  }
}

describe("0027_report_colors on production-shaped data (PGlite)", () => {
  it("is the latest migration and comes after 0025/0026", () => {
    const f = M27.folders();
    expect(f.at(-1)).toBe(M);
    expect(["0025_password_sign_in", "0026_project_start_date"]).toContain(f.at(-2));
  });

  it("is additive: two defaulted columns on report_options; every other table, column and row unchanged", async () => {
    const db = await M27.before();
    const cols = await M27.columns(db);
    const before = await M27.snapshot(db, Object.keys(cols), ["report_options"]);
    const optionsBefore = (await db.query(`select id, "showKeyPage", "updatedBy" from report_options order by id`)).rows;
    await db.exec(M27.sql());
    const after = await M27.columns(db);
    expect(Object.keys(after)).toEqual(Object.keys(cols));
    for (const t of Object.keys(cols)) if (t !== "report_options") expect(after[t], t).toEqual(cols[t]);
    expect(after.report_options.slice(0, cols.report_options.length)).toEqual(cols.report_options);
    expect(after.report_options.slice(cols.report_options.length)).toEqual(["barColor:text:NO:'navy'::text", "headerBand:text:NO:'none'::text"]);
    expect(await M27.snapshot(db, Object.keys(cols), ["report_options"])).toEqual(before);
    expect((await db.query(`select id, "showKeyPage", "updatedBy" from report_options order by id`)).rows).toEqual(optionsBefore);
    expect((await db.query(`select distinct "barColor", "headerBand" from report_options`)).rows).toEqual([{ barColor: "navy", headerBand: "none" }]);
    expect(M27.sql()).not.toMatch(/INSERT INTO|UPDATE "/i);
  });

  it("CHECK constraints accept presets and #RRGGBB only", async () => {
    const db = await M27.before();
    await db.exec(M27.sql());
    await db.exec(`update report_options set "barColor" = 'deeper-plum', "headerBand" = '#2B4C7E'`);
    await db.exec(`update report_options set "barColor" = '#FFD700', "headerBand" = 'none'`);
    await expect(db.exec(`update report_options set "barColor" = 'none'`)).rejects.toThrow(/report_options_barColor_check/);
    await expect(db.exec(`update report_options set "barColor" = '#ffd700'`)).rejects.toThrow(/report_options_barColor_check/);
    await expect(db.exec(`update report_options set "headerBand" = 'teal'`)).rejects.toThrow(/report_options_headerBand_check/);
  });

  it("schema.prisma defaults match the migration", () => {
    const schema = src("prisma/schema.prisma");
    expect(schema).toMatch(/barColor\s+String\s+@default\("navy"\)/);
    expect(schema).toMatch(/headerBand\s+String\s+@default\("none"\)/);
    expect(S.DEFAULTS).toEqual({ bar: "navy", band: "none" });
  });

  it("rolls back with the documented steps to the exact previous schema and data, and re-applies cleanly", async () => {
    const db = await M27.before();
    await db.exec(`create table if not exists "_prisma_migrations" (id varchar(36) primary key, checksum varchar(64) not null, finished_at timestamptz, migration_name varchar(255) not null, logs text, rolled_back_at timestamptz, started_at timestamptz not null default now(), applied_steps_count integer not null default 0)`);
    const cols = await M27.columns(db);
    const before = await M27.snapshot(db, Object.keys(cols));
    await db.exec(M27.sql());
    await db.query(`insert into "_prisma_migrations" (id, checksum, migration_name) values ('m27', 'c', $1)`, [M]);
    await db.exec(`update report_options set "barColor" = 'plum'`);
    const steps = M27.downSteps();
    expect(steps).toEqual([`ALTER TABLE "report_options" DROP COLUMN "headerBand";`, `ALTER TABLE "report_options" DROP COLUMN "barColor";`, `DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${M}';`]);
    for (const s of steps) await db.exec(s);
    expect(await M27.columns(db)).toEqual(cols);
    expect(await M27.snapshot(db, Object.keys(cols))).toEqual(before);
    await db.exec(M27.sql());
  });
});
