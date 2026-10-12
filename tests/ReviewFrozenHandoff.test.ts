import { createHash } from "node:crypto";
import { writeFileSync, existsSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServiceLine } from "@/lib/domain/ServiceLine";
import { ViewSettings } from "@/lib/domain/ViewSettings";
import type { Handoff } from "@/lib/report/HandoffBuilder";
import { PdfReportRenderer } from "@/lib/report/PdfReportRenderer";
import { ReportBuilder } from "@/lib/report/ReportBuilder";
import { FreezeService, type FreezeOptions } from "@/lib/services/FreezeService";
import { ProjectService } from "@/lib/services/ProjectService";
import { ReviewService } from "@/lib/services/ReviewService";
import { ViewSettingsService } from "@/lib/services/ViewSettingsService";
import type { HistoryEntryRecord } from "@/lib/domain/types";
import { Factory } from "./helpers/factories";
import { FakeDb } from "./helpers/FakeDb";

const actor = { changedBy: "nick.leary@example.org" };
const base = { serviceArea: "Cath", owner: "Owner A", status: "OnTrack", nextMilestone: "M1" };
const ENV = { SHARE_LINK_SECRET: "x".repeat(48), APP_BASE_URL: "https://tracker.example.org/", REPORT_RECIPIENT_EMAIL: "you@example.org" };
const FREEZE_TIME = new Date("2026-09-29T21:00:00Z");
const OUT = "/workspace/batch-review-sort/";

class Setup {
  static async db() {
    const fake = new FakeDb();
    const db = fake.asClient();
    await ProjectService.create({ ...base, name: "Late one", dueDate: "2026-09-20" }, actor, db);
    await ProjectService.create({ ...base, name: "On time", serviceArea: "EP", status: "AtRisk" }, actor, db);
    await ProjectService.create({ ...base, name: "Wrapped up", status: "Complete" }, actor, db);
    return { fake, db };
  }
  static opts(o: Partial<FreezeOptions> = {}): FreezeOptions {
    return { trigger: "cron", actor: "cron", env: ENV, now: FREEZE_TIME, fetch: vi.fn(), ...o };
  }
  static artifact(fake: FakeDb, kind: string): Buffer {
    return Buffer.from(fake.state.artifacts.find((a) => a.kind === kind)!.bytes as Uint8Array);
  }
  /** snapshotId and the pdf block describe a different snapshot row and a different PDF file; everything else must match. */
  static comparable(bytes: Buffer): string {
    const h = JSON.parse(bytes.toString("utf8")) as Handoff & { pdf: Record<string, unknown> };
    return JSON.stringify({ ...h, snapshotId: "<id>", pdf: { ...h.pdf, sha256: "<pdf sha>", byteSize: 0 } }, null, 2);
  }
}

afterEach(() => vi.restoreAllMocks());

describe("handoff.json ignores the PDF status chips toggle", () => {
  it("keeps the Changed / Overdue / Stale lists, identical with chips off and on", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const off = await Setup.db();
    const on = { fake: new FakeDb() };
    on.fake.state = FakeDb.clone(off.fake.state);
    const onDb = on.fake.asClient();
    const report = ViewSettings.defaults("report");
    await ViewSettingsService.update("report", { ...report, showStatusChips: false }, actor, off.db);
    await ViewSettingsService.update("report", ViewSettings.withStatusChips("report", report, true), actor, onDb);
    await FreezeService.run(Setup.opts(), off.db);
    await FreezeService.run(Setup.opts(), onDb);

    const a = Setup.artifact(off.fake, "handoff");
    const b = Setup.artifact(on.fake, "handoff");
    const h = JSON.parse(a.toString("utf8")) as Handoff;
    expect(h.flags.changed.count).toBeGreaterThan(0);
    expect(h.flags.changed.projects.map((p) => p.name)).toContain("Late one");
    expect(h.flags.overdue.projects.map((p) => p.name)).toEqual(["Late one"]);
    expect(h.flags.stale).toBeDefined();
    // The two PDFs differ (that is the toggle); the handoff differs only in the fields that point at them.
    expect(Setup.artifact(off.fake, "pdf").equals(Setup.artifact(on.fake, "pdf"))).toBe(false);
    expect(Setup.comparable(a)).toBe(Setup.comparable(b));
    expect(Buffer.from(Setup.comparable(a)).equals(Buffer.from(Setup.comparable(b)))).toBe(true);

    if (existsSync(OUT)) {
      writeFileSync(OUT + "handoff-chips-off.json", a);
      writeFileSync(OUT + "handoff-chips-on.json", b);
      const sha = (x: Buffer | string) => createHash("sha256").update(x).digest("hex");
      writeFileSync(
        OUT + "handoff-chips-note.txt",
        [
          `handoff-chips-off.json  sha256 ${sha(a)}  ${a.length} bytes`,
          `handoff-chips-on.json   sha256 ${sha(b)}  ${b.length} bytes`,
          `normalized (snapshotId + pdf.sha256/byteSize masked): off ${sha(Setup.comparable(a))}  on ${sha(Setup.comparable(b))}  identical=${Setup.comparable(a) === Setup.comparable(b)}`,
          "Raw files differ only in snapshotId (two separate test snapshots) and pdf.sha256 / pdf.byteSize (the chips-off and chips-on PDFs are different files).",
          "",
        ].join("\n"),
      );
    }
  }, 60000);
});

describe("Mark as reviewed never touches frozen reports", () => {
  it("after a freeze: snapshot, stored PDF, handoff.json and a re-render are unchanged; only the live Changed clears", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fake, db } = await Setup.db();
    await FreezeService.run(Setup.opts(), db);
    const snap = JSON.stringify(fake.state.snapshots);
    const pdf = Setup.artifact(fake, "pdf");
    const handoff = Setup.artifact(fake, "handoff");
    const rerender = async () => PdfReportRenderer.renderDocument(PdfReportRenderer.docInput(PdfReportRenderer.inputFromSnapshot(fake.state.snapshots[0] as never)));
    const before = await rerender();
    const docBefore = JSON.stringify(PdfReportRenderer.docInput(PdfReportRenderer.inputFromSnapshot(fake.state.snapshots[0] as never)));
    const deterministic = (await rerender()).equals(before);
    const layoutBefore = JSON.stringify(PdfReportRenderer.layout(PdfReportRenderer.docInput(PdfReportRenderer.inputFromSnapshot(fake.state.snapshots[0] as never))));

    const p = fake.state.projects.find((x) => x.name === "Late one")!;
    const history = fake.state.history as unknown as HistoryEntryRecord[];
    expect(ReportBuilder.flags(p as never, history, null, "2026-10-01").changed).toBe(true);
    // During the next period (after the freeze), and again later.
    // FakeDb stamps history with the real clock, so the second review is "now + 1 minute" (after every edit).
    for (const at of [new Date("2026-09-30T14:00:00Z"), new Date(Date.now() + 60_000)]) {
      const r = await ReviewService.mark(db, Factory.ADMIN, ServiceLine.defaultScope(), fake.state.projects.map((x) => x.id), true, at);
      expect(r.ids.length).toBe(3);
    }
    const again = await FreezeService.run(Setup.opts({ now: new Date("2026-10-05T21:00:00Z") }), db);
    expect(again.outcome).not.toBe("created");

    expect(JSON.stringify(fake.state.snapshots)).toBe(snap);
    expect(fake.state.artifacts).toHaveLength(2);
    expect(Setup.artifact(fake, "pdf").equals(pdf)).toBe(true);
    expect(Setup.artifact(fake, "handoff").equals(handoff)).toBe(true);
    // Re-render from the frozen snapshot: the same document input, and the same bytes when the renderer is deterministic.
    expect(JSON.stringify(PdfReportRenderer.docInput(PdfReportRenderer.inputFromSnapshot(fake.state.snapshots[0] as never)))).toBe(docBefore);
    if (deterministic) expect((await rerender()).equals(before)).toBe(true);
    // The renderer stamps a creation time, so bytes differ run to run; the laid-out page model must not.
    else expect(JSON.stringify(PdfReportRenderer.layout(PdfReportRenderer.docInput(PdfReportRenderer.inputFromSnapshot(fake.state.snapshots[0] as never))))).toBe(layoutBefore);

    const live = fake.state.projects.find((x) => x.name === "Late one")!;
    expect(ReportBuilder.flags(live as never, fake.state.history as unknown as HistoryEntryRecord[], null, "2026-10-06").changed).toBe(false);
  }, 60000);
});
