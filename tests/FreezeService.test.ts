import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import type { Handoff } from "@/lib/report/HandoffBuilder";
import { SignedLink } from "@/lib/report/SignedLink";
import { FreezeService, type FreezeOptions } from "@/lib/services/FreezeService";
import { ProjectService } from "@/lib/services/ProjectService";
import { ReportArchiveService } from "@/lib/services/ReportArchiveService";
import type { DeliveryRecord } from "@/lib/services/ReportDeliveryService";
import { Factory } from "./helpers/factories";
import { FakeDb } from "./helpers/FakeDb";

const actor = { changedBy: "nick.leary@example.org" };
const base = { serviceArea: "Cath", owner: "Owner A", status: "OnTrack", nextMilestone: "M1" };
const SECRET = "x".repeat(48);
const ENV = { SHARE_LINK_SECRET: SECRET, APP_BASE_URL: "https://tracker.example.org/", REPORT_RECIPIENT_EMAIL: "you@example.org" };
const DRIVE_ENV = { ...ENV, GOOGLE_DRIVE_CLIENT_ID: "cid", GOOGLE_DRIVE_CLIENT_SECRET: "csecret", GOOGLE_DRIVE_REFRESH_TOKEN: "rtoken" };
const FREEZE_TIME = new Date("2026-09-29T21:00:00Z"); // Tue 5:00 PM EDT

class Setup {
  static async db() {
    const fake = new FakeDb();
    const db = fake.asClient();
    await ProjectService.create({ ...base, name: "Visible late", dueDate: "2026-09-20", physicianChampion: "Dr. Sample A" }, actor, db);
    await ProjectService.create({ ...base, name: "Visible ok", serviceArea: "EP", status: "AtRisk" }, actor, db);
    const hidden = await ProjectService.create({ ...base, name: "SecretHidden", dueDate: "2026-09-01" }, actor, db);
    await ProjectService.setHidden(hidden.id, "report", true, Factory.ADMIN, db);
    await ProjectService.create({ ...base, name: "SecretDone", status: "Complete" }, actor, db);
    return { fake, db };
  }

  static opts(overrides: Partial<FreezeOptions> = {}): FreezeOptions {
    return { trigger: "cron", actor: "cron", env: ENV, now: FREEZE_TIME, fetch: vi.fn(), ...overrides };
  }

  static handoff(fake: FakeDb): Handoff {
    const a = fake.state.artifacts.find((x) => x.kind === "handoff")!;
    return JSON.parse(Buffer.from(a.bytes as Uint8Array).toString("utf8")) as Handoff;
  }

  static json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }
}

afterEach(() => vi.restoreAllMocks());

describe("FreezeService schedule and idempotency", () => {
  it("cron before the first freeze time does nothing", async () => {
    const { fake, db } = await Setup.db();
    const r = await FreezeService.run(Setup.opts({ now: new Date("2026-09-29T20:30:00Z") }), db);
    expect(r.outcome).toBe("skipped");
    expect(fake.state.snapshots).toHaveLength(0);
  });

  it("freezes once per period: snapshot, PDF, handoff.json, delivery; re-runs are no-ops", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fake, db } = await Setup.db();
    const r1 = await FreezeService.run(Setup.opts(), db);
    expect(r1.outcome).toBe("created");
    expect(r1.period).toEqual({ periodStart: "2026-09-15", periodEnd: "2026-09-29" });
    expect(fake.state.snapshots).toHaveLength(1);
    const snap = fake.state.snapshots[0];
    const pdf = fake.state.artifacts.find((a) => a.kind === "pdf")!;
    expect(Buffer.from(pdf.bytes as Uint8Array).subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.fileName).toBe("cardiac-portfolio-report-2026-09-29.pdf");
    expect(snap.pdfStorageKey).toBe(`db:report_artifacts/${pdf.id}`);
    expect((snap.deliveryJson as DeliveryRecord).status).toBe("signed_link");

    // Same day later (the 22:00 UTC cron), an off-week day, and a manual run: nothing new.
    const r2 = await FreezeService.run(Setup.opts({ now: new Date("2026-09-29T22:10:00Z") }), db);
    const r3 = await FreezeService.run(Setup.opts({ now: new Date("2026-10-06T21:10:00Z") }), db);
    const r4 = await FreezeService.run(Setup.opts({ trigger: "manual", actor: "admin@example.org", now: new Date("2026-10-01T15:00:00Z") }), db);
    for (const r of [r2, r3, r4]) {
      expect(r.outcome).toBe("already_frozen");
      expect(r.snapshotId).toBe(snap.id);
      expect(r.delivery).toBeNull();
    }
    expect(fake.state.snapshots).toHaveLength(1);
    expect(fake.state.artifacts).toHaveLength(2);
    expect(fake.state.deliveries).toHaveLength(2); // one drive "skipped" + one signed_link "ok", from the first run only

    // Two weeks later the next period freezes.
    const r5 = await FreezeService.run(Setup.opts({ now: new Date("2026-10-13T21:20:00Z") }), db);
    expect(r5.outcome).toBe("created");
    expect(r5.period).toEqual({ periodStart: "2026-09-29", periodEnd: "2026-10-13" });
    expect(fake.state.snapshots).toHaveLength(2);
  });

  it("concurrent runs create a single snapshot", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fake, db } = await Setup.db();
    const results = await Promise.all([FreezeService.run(Setup.opts(), db), FreezeService.run(Setup.opts(), db)]);
    expect(fake.state.snapshots).toHaveLength(1);
    expect(new Set(results.map((r) => r.snapshotId)).size).toBe(1);
    expect(fake.state.artifacts.filter((a) => a.kind === "pdf")).toHaveLength(1);
  });

  it("manual 'Freeze now' freezes today's period early on a freeze day, refuses when nothing is due", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fake, db } = await Setup.db();
    const refused = await FreezeService.run(Setup.opts({ trigger: "manual", actor: "admin@example.org", now: new Date("2026-09-26T15:00:00Z") }), db);
    expect(refused.outcome).toBe("refused");
    expect(refused.message).toContain("Tuesday, Sep 29, 2026 at 5 PM ET");
    expect(fake.state.snapshots).toHaveLength(0);

    const early = await FreezeService.run(Setup.opts({ trigger: "manual", actor: "admin@example.org", now: new Date("2026-09-29T18:00:00Z") }), db);
    expect(early.outcome).toBe("created");
    expect(fake.state.snapshots[0].generatedBy).toBe("admin@example.org");
    const cron = await FreezeService.run(Setup.opts(), db);
    expect(cron.outcome).toBe("already_frozen");
    expect(fake.state.snapshots).toHaveLength(1);
  });
});

describe("handoff.json", () => {
  it("has period, freeze time, snapshot id, visible counts, visible flags, archive link and the recipient; no To/Cc or champion list", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fake, db } = await Setup.db();
    const r = await FreezeService.run(Setup.opts(), db);
    const h = Setup.handoff(fake);
    expect(h).toMatchObject({
      schemaVersion: 1,
      title: "Cardiac Service Line: Project Status Report",
      snapshotId: r.snapshotId,
      reportDate: "2026-09-29",
      period: { start: "2026-09-15", end: "2026-09-29", label: "Sep 15 \u2013 Sep 29, 2026" },
      frozenAt: "2026-09-29T21:00:00.000Z",
      frozenAtEt: "Sep 29, 2026, 5:00 PM ET",
      reportRecipient: "you@example.org",
      totals: { projects: 2, byStatus: { OnTrack: 1, AtRisk: 1 } },
      archiveUrl: "https://tracker.example.org/reports",
    });
    expect(h.byArea.find((a) => a.area === "Cath")).toMatchObject({ projects: 1, byStatus: { OnTrack: 1 } });
    expect(h.flags.overdue.count).toBe(1);
    expect(h.flags.overdue.projects.map((p) => p.name)).toEqual(["Visible late"]);
    expect(h.flags.changed.count).toBe(2);
    expect(h.flags.stale).toEqual({ count: 0, projects: [] });
    expect(h.pdf.fileName).toBe("cardiac-portfolio-report-2026-09-29.pdf");
    const text = JSON.stringify(h);
    expect(text).not.toMatch(/Secret/);
    expect(text).not.toMatch(/"to"|"cc"|missingChampion|Dr\. Sample/i);
    expect(text).not.toContain("\u2014");
  });

  it("counts Stale (14+ days since the last update) on visible rows only", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fake, db } = await Setup.db();
    const quiet = await ProjectService.create({ ...base, name: "Visible quiet", serviceArea: "EP" }, actor, db);
    const edge = await ProjectService.create({ ...base, name: "Visible 13 days", serviceArea: "EP" }, actor, db);
    const age = (id: string, iso: string) => {
      for (const h of fake.state.history) if (h.projectId === id) h.changedAt = new Date(iso);
    };
    age(quiet.id, "2026-09-10T16:00:00Z"); // 19 days before Sep 29
    age(edge.id, "2026-09-16T16:00:00Z"); // 13 days
    // Hidden and Complete projects are old too, but never counted.
    for (const p of fake.state.projects) if (String(p.name).startsWith("Secret")) age(String(p.id), "2026-08-01T16:00:00Z");
    await FreezeService.run(Setup.opts(), db);
    const h = Setup.handoff(fake);
    expect(h.flags.stale.count).toBe(1);
    expect(h.flags.stale.projects.map((p) => p.name)).toEqual(["Visible quiet"]);
  });

  it("omits reportRecipient and logs a warning when REPORT_RECIPIENT_EMAIL is unset or invalid", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const value of [undefined, "", "a@example.org, b@example.org"]) {
      const { fake, db } = await Setup.db();
      await FreezeService.run(Setup.opts({ env: { ...ENV, REPORT_RECIPIENT_EMAIL: value } }), db);
      expect("reportRecipient" in Setup.handoff(fake)).toBe(false);
    }
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("handoff.recipient.missing"))).toHaveLength(3);
  });
});

describe("delivery", () => {
  it("uploads the PDF and handoff.json to Google Drive when configured", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { fake, db } = await Setup.db();
    let upload = 0;
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        expect(String(init?.body)).toContain("grant_type=refresh_token");
        return Setup.json({ access_token: "at" });
      }
      if (url.startsWith("https://www.googleapis.com/drive/v3/files?")) return Setup.json({ files: [{ id: "folder1" }] });
      if (url.startsWith("https://www.googleapis.com/upload/drive/v3/files")) {
        expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer at");
        upload += 1;
        return Setup.json({ id: `file${upload}`, webViewLink: `https://drive.example/${upload}` });
      }
      throw new Error(`unexpected ${url}`);
    });
    const r = await FreezeService.run(Setup.opts({ env: DRIVE_ENV, fetch }), db);
    expect(r.delivery).toMatchObject({
      status: "drive",
      drive: { folderId: "folder1", files: [{ name: "cardiac-portfolio-report-2026-09-29.pdf", id: "file1" }, { name: "handoff-2026-09-29.json", id: "file2" }] },
    });
    expect(r.delivery?.signedLink).toBeUndefined();
    expect(fake.state.deliveries.map((d) => [d.method, d.status])).toEqual([["drive", "ok"]]);
  });

  it("falls back to a 7-day signed link when Drive fails, records both attempts, and retries Drive on the next run", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { fake, db } = await Setup.db();
    const failing = vi.fn(async () => new Response("invalid_grant", { status: 400 }));
    const r = await FreezeService.run(Setup.opts({ env: DRIVE_ENV, fetch: failing }), db);
    expect(r.delivery?.status).toBe("signed_link");
    expect(r.delivery?.driveError).toContain("Token refresh failed (HTTP 400)");
    expect(r.delivery?.signedLink?.pdfUrl).toMatch(/^https:\/\/tracker\.example\.org\/api\/share\/[\w-]+\.[\w-]+\/pdf$/);
    expect(new Date(r.delivery!.signedLink!.expiresAt).getTime() - FREEZE_TIME.getTime()).toBe(7 * 86_400_000);
    expect(fake.state.deliveries.map((d) => [d.method, d.status])).toEqual([
      ["drive", "failed"],
      ["signed_link", "ok"],
    ]);
    expect(error.mock.calls.some((c) => String(c[0]).includes("delivery.drive.failed"))).toBe(true);
    expect((fake.state.snapshots[0].deliveryJson as DeliveryRecord).status).toBe("signed_link");

    // The link serves the files without sign-in until it expires.
    const token = r.delivery!.signedLink!.pdfUrl.split("/").at(-2)!;
    const env = DRIVE_ENV;
    const pdf = await ReportArchiveService.shared(token, "pdf", db, env, new Date("2026-10-01T12:00:00Z"));
    expect(pdf?.kind).toBe("pdf");
    expect(await ReportArchiveService.shared(token, "handoff", db, env, new Date("2026-10-01T12:00:00Z"))).not.toBeNull();
    expect(await ReportArchiveService.shared(token, "pdf", db, env, new Date("2026-10-06T21:00:00Z"))).toBeNull(); // expired
    expect(await ReportArchiveService.shared(`${token}x`, "pdf", db, env, new Date("2026-10-01T12:00:00Z"))).toBeNull(); // tampered

    // Next cron run: Drive is configured but was not used, so it retries (and succeeds now).
    let n = 0;
    const ok = vi.fn(async (url: string) =>
      url.includes("oauth2") ? Setup.json({ access_token: "at" }) : url.includes("/upload/") ? Setup.json({ id: `f${++n}` }) : Setup.json({ files: [] , id: "newfolder" }),
    );
    const r2 = await FreezeService.run(Setup.opts({ env: DRIVE_ENV, fetch: ok, now: new Date("2026-09-30T21:00:00Z") }), db);
    expect(r2.outcome).toBe("already_frozen");
    expect(r2.delivery?.status).toBe("drive");
    expect(fake.state.snapshots).toHaveLength(1);
  });

  it("uses the signed link when Drive is not configured and marks failure when there is no link secret either", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    const a = await Setup.db();
    const fetch = vi.fn();
    const r = await FreezeService.run(Setup.opts({ fetch }), a.db);
    expect(r.delivery).toMatchObject({ status: "signed_link", driveError: "Google Drive is not configured" });
    expect(fetch).not.toHaveBeenCalled();

    const b = await Setup.db();
    const r2 = await FreezeService.run(Setup.opts({ env: { SHARE_LINK_SECRET: "too-short" } }), b.db);
    expect(r2.delivery?.status).toBe("failed");
    expect(r2.delivery?.signedLinkError).toContain("SHARE_LINK_SECRET");
    // A failed delivery is retried on the next run.
    const r3 = await FreezeService.run(Setup.opts({ now: new Date("2026-09-30T21:00:00Z") }), b.db as PrismaClient);
    expect(r3.delivery?.status).toBe("signed_link");
  });

  it("signed links for one snapshot never open another", async () => {
    const token = SignedLink.sign("00000000-0000-0000-0000-000000000000", new Date("2026-10-06T00:00:00Z"), SECRET);
    const { db } = await Setup.db();
    expect(await ReportArchiveService.shared(token, "pdf", db, ENV, FREEZE_TIME)).toBeNull();
  });
});

describe("report options (key page)", () => {
  it("defaults on, is admin-only, audited, and frozen into each snapshot", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ReportOptionsService } = await import("@/lib/services/ReportOptionsService");
    const { fake, db } = await Setup.db();
    expect(await ReportOptionsService.get(db)).toEqual({ showKeyPage: true });
    await expect(ReportOptionsService.update({ showKeyPage: false }, Factory.MEMBER, db)).rejects.toThrow();
    await ReportOptionsService.update({ showKeyPage: false }, Factory.ADMIN, db);
    expect(fake.state.reportOptionsHistory).toHaveLength(1);
    await ReportOptionsService.update({ showKeyPage: false }, Factory.ADMIN, db); // no-op, not audited again
    expect(fake.state.reportOptionsHistory).toHaveLength(1);
    await FreezeService.run(Setup.opts(), db);
    expect(fake.state.snapshots[0].optionsJson).toEqual({ showKeyPage: false });
  });
});
