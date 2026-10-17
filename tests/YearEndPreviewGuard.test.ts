import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { FakeDb } from "./helpers/FakeDb";
import { Factory } from "./helpers/factories";

// Preview deployments share the production database, so YearEndReportService.generate (the only year-end row write)
// refuses under VERCEL_ENV=preview with the same FreezeGuard check and FreezeDisabledError as #84. The action resolves the
// viewer from the session and uses Db.client; both are swapped for fakes here (fictional data only).
const h = vi.hoisted(() => ({ viewer: null as Viewer | null, db: null as unknown }));
vi.mock("@/lib/auth/CurrentViewer", () => ({ CurrentViewer: { get: async () => h.viewer } }));
vi.mock("@/lib/db/Db", () => ({ Db: { get client() { return h.db; }, isConfigured: () => true } }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const { YearEndReportService } = await import("@/lib/services/YearEndReportService");
const { YearEndRenderer } = await import("@/lib/report/YearEndRenderer");
const { FreezeDisabledError, FreezeGuard } = await import("@/lib/report/FreezeGuard");
const { YearEndPreviewCopy } = await import("@/lib/report/YearEndPreviewCopy");
const YEAR_END_NOTE = "Year-end reports are turned off on preview deployments.";
const { ServiceLine } = await import("@/lib/domain/ServiceLine");
const { generateYearEndReport } = await import("@/app/actions/reports");

const NOW = new Date("2026-09-27T16:00:00Z");
const ADMIN = { ...Factory.ADMIN, name: "Fictional Admin" };
let fake: FakeDb;

/** The fake client, recording every property the service touches (any model read or write goes through one). */
function watched(): { db: PrismaClient; touched: string[] } {
  const touched: string[] = [];
  const db = new Proxy(fake.asClient() as object, {
    get(target, key, receiver) {
      if (typeof key === "string") touched.push(key);
      return Reflect.get(target, key, receiver);
    },
  }) as PrismaClient;
  return { db, touched };
}

beforeEach(() => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  fake = new FakeDb();
  h.db = fake.asClient();
  fake.state.projects.push({ ...Factory.project(), name: "Fictional finished project", status: "Complete", completedOn: Factory.date("2026-08-01"), createdAt: new Date("2026-01-05T15:00:00Z"), serviceLineId: ServiceLine.DEFAULT_ID } as never);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  h.viewer = null;
});

describe("YearEndReportService.generate under VERCEL_ENV=preview", () => {
  beforeEach(() => vi.stubEnv("VERCEL_ENV", "preview"));

  it("refuses with FreezeDisabledError before any read, render or write", async () => {
    const render = vi.spyOn(YearEndRenderer, "render");
    for (const fy of ["FY27", "FY26"]) {
      const before = fake.state.yearEndReports.length;
      const { db, touched } = watched();
      await expect(YearEndReportService.generate(ADMIN, fy, ServiceLine.defaultScope(), db, NOW)).rejects.toThrow(FreezeDisabledError);
      expect(fake.state.yearEndReports.length).toBe(before);
      expect(touched).toEqual([]);
    }
    expect(render).not.toHaveBeenCalled();
    expect(fake.writes.filter((w) => w.model === "yearEndReport")).toEqual([]);
    expect(fake.state.yearEndReports).toHaveLength(0);
  });

  it("refuses with the same error even for a non-admin (the guard runs first) and for any category set", async () => {
    await expect(YearEndReportService.generate(Factory.MEMBER, "FY27", ServiceLine.defaultScope(), fake.asClient(), NOW)).rejects.toThrow(FreezeDisabledError);
    await expect(YearEndReportService.generate(ADMIN, "FY27", ServiceLine.defaultScope(), fake.asClient(), NOW, ["completed"] as never)).rejects.toThrow(FreezeDisabledError);
    expect(fake.state.yearEndReports).toHaveLength(0);
  });

  it("the Generate PDF action returns an error state with the year-end note's words and writes no year-end row", async () => {
    expect(YearEndPreviewCopy.NOTE).toBe(YEAR_END_NOTE);
    // The shared freeze message is unchanged (the service still throws FreezeDisabledError with it).
    expect(new FreezeDisabledError().message).toBe("Freezing is turned off on preview deployments.");
    h.viewer = Factory.ADMIN as unknown as Viewer;
    const before = fake.state.yearEndReports.length;
    expect(await generateYearEndReport("FY27")).toEqual({ ok: false, message: YEAR_END_NOTE });
    expect(fake.state.yearEndReports.length).toBe(before);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("the action keeps its earlier refusals (not admin, no categories) ahead of the guard", async () => {
    h.viewer = Factory.MEMBER as unknown as Viewer;
    expect(await generateYearEndReport("FY27")).toEqual({ ok: false, message: "Not authorized." });
    h.viewer = Factory.ADMIN as unknown as Viewer;
    expect((await generateYearEndReport("FY27", [])).ok).toBe(false);
    expect(fake.state.yearEndReports).toHaveLength(0);
  });

  it("reads (years, list, file) still work on previews; they write nothing", async () => {
    const scope = ServiceLine.defaultScope();
    expect(await YearEndReportService.years(ADMIN, scope, fake.asClient(), NOW)).toContain("FY27");
    expect(await YearEndReportService.list(scope, fake.asClient())).toEqual([]);
    expect(FreezeGuard.disabled()).toBe(true);
  });
});

describe("YearEndReportService.generate outside preview is unchanged", () => {
  for (const v of [undefined, "production", "development"]) {
    it(`stores the report as before with VERCEL_ENV ${v ?? "unset"}`, async () => {
      vi.stubEnv("VERCEL_ENV", v as unknown as string);
      const e = await YearEndReportService.generate(ADMIN, "FY27", ServiceLine.defaultScope(), fake.asClient(), NOW);
      expect(e).toMatchObject({ fiscalYear: "FY27", toDate: true, fileName: "mid-year-fy27-2026-09-27.pdf" });
      expect(fake.writes.map((w) => w.model)).toEqual(["yearEndReport"]);
      expect(fake.state.yearEndReports).toHaveLength(1);
      expect(Buffer.from(fake.state.yearEndReports[0].bytes as Uint8Array).subarray(0, 5).toString()).toBe("%PDF-");
    }, 30000);
  }

  it("the action generates and returns the stored file in production", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    h.viewer = Factory.ADMIN as unknown as Viewer;
    const r = await generateYearEndReport("FY27");
    expect(r).toMatchObject({ ok: true, fileName: expect.stringMatching(/^mid-year-fy27-\d{4}-\d{2}-\d{2}\.pdf$/) });
    expect(fake.state.yearEndReports).toHaveLength(1);
  }, 30000);
});

describe("YearEndReportButton", () => {
  it("on a preview: disabled with the shared note component and disabled style; no dialog even with initialOpen", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { YearEndReportButton } = await import("@/components/YearEndReportButton");
    const { FREEZE_DISABLED_BUTTON } = await import("@/components/FreezeDisabledNote");
    const off = renderToStaticMarkup(createElement(YearEndReportButton, { years: ["FY27"], current: "FY27", initialOpen: true, disabledNote: YearEndPreviewCopy.NOTE }));
    expect(off).toContain(`<span data-testid="year-end-disabled-note" class="type-caption text-muted">${YEAR_END_NOTE}</span>`);
    expect(off).toMatch(new RegExp(`<button type="button" class="[^"]*${FREEZE_DISABLED_BUTTON}" disabled=""`));
    expect(off).not.toContain('role="dialog"');
  });

  it("outside preview the markup is exactly what it was before (no prop and null render the same)", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { YearEndReportButton } = await import("@/components/YearEndReportButton");
    const html = renderToStaticMarkup(createElement(YearEndReportButton, { years: ["FY27"], current: "FY27" }));
    expect(html).toBe('<button type="button" class="h-8 rounded-control border border-line px-3.5 type-table-strong hover:text-fg" aria-haspopup="dialog" data-testid="year-end-button">Year-end report</button>');
    expect(renderToStaticMarkup(createElement(YearEndReportButton, { years: ["FY27"], current: "FY27", disabledNote: null }))).toBe(html);
  });
});
