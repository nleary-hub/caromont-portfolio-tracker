import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { FakeDb } from "./helpers/FakeDb";
import { Factory } from "./helpers/factories";

// The routes resolve the viewer from the session and use Db.client; both are swapped for fakes here.
const h = vi.hoisted(() => ({ viewer: null as Viewer | null, db: null as unknown }));
vi.mock("@/lib/auth/CurrentViewer", () => ({ CurrentViewer: { get: async () => h.viewer } }));
vi.mock("@/lib/db/Db", () => ({ Db: { get client() { return h.db; }, isConfigured: () => true } }));

const { GET: previewGET } = await import("@/app/api/reports/preview/route");
const { GET: cronGET } = await import("@/app/api/cron/freeze/route");
const { ProjectService } = await import("@/lib/services/ProjectService");
const { DraftReportService } = await import("@/lib/services/DraftReportService");
const { ReportLayout } = await import("@/lib/report/pdf/ReportLayout");
const { ReportHttp } = await import("@/lib/report/ReportHttp");

const actor = { changedBy: "nick.leary@example.org" };

let fake: FakeDb;
beforeEach(async () => {
  fake = new FakeDb();
  h.db = fake.asClient();
  await ProjectService.create({ serviceArea: "Cath", owner: "Owner A", status: "OnTrack", nextMilestone: "M1", name: "Live project" }, actor, fake.asClient());
  const hidden = await ProjectService.create({ serviceArea: "EP", owner: "Owner B", status: "AtRisk", nextMilestone: "M2", name: "SecretHidden" }, actor, fake.asClient());
  await ProjectService.setHidden(hidden.id, "report", true, Factory.ADMIN, fake.asClient());
});
afterEach(() => {
  vi.restoreAllMocks();
  h.viewer = null;
});

describe("Generate PDF now (draft preview)", () => {
  it("returns a PDF attachment to an admin, built from live data, with no snapshot, archive, artifact, delivery or Drive call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    h.viewer = Factory.ADMIN;
    const snapshotsBefore = fake.state.snapshots.length;
    const writesBefore = fake.writes.length;
    const res = await previewGET();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toMatch(/^attachment; filename="cardiac-portfolio-report-draft-\d{4}-\d{2}-\d{2}\.pdf"$/);
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(fake.state.snapshots).toHaveLength(snapshotsBefore);
    expect(fake.state.artifacts).toHaveLength(0);
    expect(fake.state.deliveries).toHaveLength(0);
    expect(fake.writes.length).toBe(writesBefore); // read-only: nothing written, nothing audited
    // The PDF layout engine loads its WASM through a data: URL; no network request may happen.
    const network = fetchSpy.mock.calls.map((c) => String(c[0])).filter((u) => !u.startsWith("data:"));
    expect(network).toEqual([]);
  });

  it("answers 404 to a signed-in non-admin and to no session", async () => {
    h.viewer = Factory.MEMBER;
    expect((await previewGET()).status).toBe(404);
    h.viewer = null;
    expect((await previewGET()).status).toBe(404);
    expect(fake.state.snapshots).toHaveLength(0);
  });

  it("uses the same builder and report settings as the freeze, and is labeled a draft", async () => {
    const now = new Date("2026-09-26T16:00:00Z");
    expect(await DraftReportService.render(Factory.MEMBER, fake.asClient(), now)).toBeNull();
    const draft = await DraftReportService.render(Factory.ADMIN, fake.asClient(), now);
    expect(draft!.fileName).toBe("cardiac-portfolio-report-draft-2026-09-26.pdf");
    // Layout for the same live input: draft line, visible rows only.
    const { ReportDataLoader } = await import("@/lib/report/ReportDataLoader");
    const data = await ReportDataLoader.load(fake.asClient(), now);
    const layout = ReportLayout.layout({ ...data, periodStart: "2026-09-15", periodEnd: "2026-09-29", generatedAt: now, draft: true });
    // No DRAFT watermark and no generated time in any header; the footer still says "Draft <time>".
    expect(layout.header.badge).toBeNull();
    expect(layout.header.footerLeft).toMatch(/^Draft Sep 26, 2026, 12:00 PM ET/);
    expect(JSON.stringify(layout)).not.toContain("SecretHidden");
    expect(data.rows.map((r) => r.name)).toEqual(["Live project"]);
  });
});

describe("cron route auth", () => {
  it("rejects requests without the CRON_SECRET bearer (fails closed when unset)", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await cronGET(new Request("https://x/api/cron/freeze"))).status).toBe(401);
    vi.stubEnv("CRON_SECRET", "c".repeat(40));
    expect((await cronGET(new Request("https://x/api/cron/freeze", { headers: { authorization: "Bearer wrong" } }))).status).toBe(401);
    expect(ReportHttp.cronAuthorized(`Bearer ${"c".repeat(40)}`)).toBe(true);
    expect(ReportHttp.cronAuthorized(`bearer ${"c".repeat(40)}`)).toBe(false);
    expect(fake.state.snapshots).toHaveLength(0);
    vi.unstubAllEnvs();
  });

  it("runs the freeze with a valid bearer", async () => {
    vi.stubEnv("CRON_SECRET", "c".repeat(40));
    vi.spyOn(console, "info").mockImplementation(() => {});
    const res = await cronGET(new Request("https://x/api/cron/freeze", { headers: { authorization: `Bearer ${"c".repeat(40)}` } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { outcome: string };
    expect(["created", "already_frozen", "skipped"]).toContain(body.outcome);
    vi.unstubAllEnvs();
  });
});
