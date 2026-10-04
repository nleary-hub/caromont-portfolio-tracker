import { afterEach, describe, expect, it, vi } from "vitest";
import { PdfReportRenderer } from "@/lib/report/PdfReportRenderer";
import { ReportHttp } from "@/lib/report/ReportHttp";
import { StoredPdfCopy, StoredPdfMissingError } from "@/lib/report/StoredPdf";
import { FreezeService, type FreezeOptions } from "@/lib/services/FreezeService";
import { ProjectService } from "@/lib/services/ProjectService";
import { ReportArchiveService } from "@/lib/services/ReportArchiveService";
import { FakeDb } from "./helpers/FakeDb";

const actor = { changedBy: "nick.leary@example.org" };
const ENV = { SHARE_LINK_SECRET: "x".repeat(48), APP_BASE_URL: "https://tracker.example.org/", REPORT_RECIPIENT_EMAIL: "you@example.org" };
const FREEZE_TIME = new Date("2026-09-29T21:00:00Z"); // Tue 5:00 PM EDT
const opts = (o: Partial<FreezeOptions> = {}): FreezeOptions => ({ trigger: "cron", actor: "cron", env: ENV, now: FREEZE_TIME, fetch: vi.fn(), ...o });

async function frozen() {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const fake = new FakeDb();
  const db = fake.asClient();
  await ProjectService.create({ serviceArea: "Cath", owner: "Owner A", status: "OnTrack", nextMilestone: "M1", name: "Visible" }, actor, db);
  const r = await FreezeService.run(opts(), db);
  expect(r.outcome).toBe("created");
  return { fake, db, snapshotId: r.snapshotId! };
}

afterEach(() => vi.restoreAllMocks());

describe("A frozen report whose stored PDF is missing is never rebuilt from the snapshot", () => {
  it("the first freeze run still renders and stores the PDF", async () => {
    const { fake } = await frozen();
    expect(fake.state.artifacts.filter((a) => a.kind === "pdf")).toHaveLength(1);
    expect(fake.state.snapshots[0].pdfStorageKey).toMatch(/^db:report_artifacts\//);
  });

  it("a re-run after the stored PDF went missing stops with StoredPdfMissingError and renders nothing", async () => {
    const { fake, db, snapshotId } = await frozen();
    fake.state.artifacts = fake.state.artifacts.filter((a) => a.kind !== "pdf");
    const render = vi.spyOn(PdfReportRenderer, "render");
    await expect(FreezeService.run(opts({ now: new Date("2026-09-29T22:10:00Z") }), db)).rejects.toBeInstanceOf(StoredPdfMissingError);
    expect(render).not.toHaveBeenCalled();
    expect(fake.state.artifacts.filter((a) => a.kind === "pdf")).toHaveLength(0);
    const snapshot = fake.state.snapshots.find((s) => s.id === snapshotId)!;
    await expect(FreezeService.complete(snapshot as never, opts(), db)).rejects.toThrow(StoredPdfMissingError);
    expect(render).not.toHaveBeenCalled();
  });

  it("a snapshot that never stored a PDF (run stopped before it) still gets its first-time PDF", async () => {
    const { fake, db, snapshotId } = await frozen();
    fake.state.artifacts = fake.state.artifacts.filter((a) => a.kind !== "pdf");
    const snapshot = fake.state.snapshots.find((s) => s.id === snapshotId)!;
    snapshot.pdfStorageKey = null;
    await FreezeService.complete(snapshot as never, opts(), db);
    expect(fake.state.artifacts.filter((a) => a.kind === "pdf")).toHaveLength(1);
  });

  it("the archive download shows Saved PDF not found with the real freeze day, and no Rebuild button", async () => {
    const { fake, db, snapshotId } = await frozen();
    expect(await ReportArchiveService.storedPdfMissing(snapshotId, db)).toBeNull();
    fake.state.artifacts = fake.state.artifacts.filter((a) => a.kind !== "pdf");
    const missing = await ReportArchiveService.storedPdfMissing(snapshotId, db);
    expect(missing?.generatedAt).toEqual(fake.state.snapshots[0].generatedAt);
    expect(await ReportArchiveService.storedPdfMissing("not-a-uuid", db)).toBeNull();
    const res = ReportHttp.storedPdfMissing(missing!.generatedAt);
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain("<h1>Saved PDF not found</h1>");
    expect(html).toContain("This report was frozen on Sep 29, 2026, but its saved PDF is missing. We won&#39;t rebuild it".replace("&#39;", "'"));
    expect(html).toContain("Ask an admin to restore the file.");
    expect(html).toContain('aria-label="Error: saved PDF not found"');
    expect(html).not.toMatch(/rebuild<\/button>|<button/i);
    expect(StoredPdfCopy.message("Sep 29, 2026")).not.toMatch(/\u2014/);
  });
});
