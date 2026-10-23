import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import type { FreezeOptions } from "@/lib/services/FreezeService";
import { FakeDb } from "./helpers/FakeDb";
import { Factory } from "./helpers/factories";

// Preview deployments share the production database, so every FreezeService write refuses under VERCEL_ENV=preview.
// The routes resolve the viewer from the session and use Db.client; both are swapped for fakes here (fictional data).
const h = vi.hoisted(() => ({ viewer: null as Viewer | null, db: null as unknown }));
vi.mock("@/lib/auth/CurrentViewer", () => ({ CurrentViewer: { get: async () => h.viewer } }));
vi.mock("@/lib/db/Db", () => ({ Db: { get client() { return h.db; }, isConfigured: () => true } }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const { FreezeService } = await import("@/lib/services/FreezeService");
const { FreezeDisabledError, FreezeGuard } = await import("@/lib/report/FreezeGuard");
const { SnapshotService } = await import("@/lib/services/SnapshotService");
const { ProjectService } = await import("@/lib/services/ProjectService");
const { GET: cronGET, POST: cronPOST } = await import("@/app/api/cron/freeze/route");
const { freezeNow } = await import("@/app/actions/reports");

// Roles & Permissions: freeze, archive, report options and year-end storage are Owner-only; the admin here is the Owner.
beforeEach(() => {
  vi.stubEnv("OWNER_EMAIL", "admin@example.org");
});

const ENV = { SHARE_LINK_SECRET: "x".repeat(48), APP_BASE_URL: "https://tracker.example.org/", REPORT_RECIPIENT_EMAIL: "you@example.org" };
const FREEZE_TIME = new Date("2026-09-29T21:00:00Z"); // Tue 5:00 PM EDT
const SECRET = "c".repeat(40);
const MESSAGE = "Freezing is turned off on preview deployments.";

let fake: FakeDb;
const opts = (o: Partial<FreezeOptions> = {}): FreezeOptions => ({ trigger: "cron", actor: "cron", env: ENV, now: FREEZE_TIME, fetch: vi.fn(), ...o });
const counts = () => ({ snapshots: fake.state.snapshots.length, artifacts: fake.state.artifacts.length, deliveries: fake.state.deliveries.length });
const snapshotOnly = () => SnapshotService.create({ periodStart: "2026-09-15", periodEnd: "2026-09-29", generatedBy: "cron", now: FREEZE_TIME }, fake.asClient());

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-28T14:00:00Z"));
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  fake = new FakeDb();
  h.db = fake.asClient();
  await ProjectService.create({ serviceArea: "Cath", owner: "Owner A", status: "OnTrack", nextMilestone: "M1", name: "Fictional project" }, { changedBy: "nick.leary@example.org" }, fake.asClient());
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  h.viewer = null;
});

describe("FreezeGuard", () => {
  it("is off unless VERCEL_ENV is exactly preview", () => {
    for (const v of ["", "production", "development"]) {
      vi.stubEnv("VERCEL_ENV", v);
      expect(FreezeGuard.disabled()).toBe(false);
      expect(() => FreezeGuard.assertAllowed()).not.toThrow();
    }
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(FreezeGuard.disabled()).toBe(true);
    expect(() => FreezeGuard.assertAllowed()).toThrow(FreezeDisabledError);
    expect(new FreezeDisabledError().message).toBe(MESSAGE);
    expect(FreezeGuard.NOTE).toBe("Freezing is turned off on preview deployments.");
  });
});

describe("FreezeService under VERCEL_ENV=preview writes nothing", () => {
  beforeEach(() => vi.stubEnv("VERCEL_ENV", "preview"));

  it("run (cron and manual) refuses before any snapshot, PDF, handoff or delivery row", async () => {
    for (const trigger of ["cron", "manual"] as const) {
      const before = counts();
      const o = opts({ trigger, actor: trigger === "cron" ? "cron" : "admin@example.org" });
      await expect(FreezeService.run(o, fake.asClient())).rejects.toThrow(FreezeDisabledError);
      expect(counts()).toEqual(before);
      expect(o.fetch).not.toHaveBeenCalled();
    }
    expect(fake.state.snapshots).toHaveLength(0);
  });

  it("a caller-supplied env cannot opt out (the guard reads process.env)", async () => {
    await expect(FreezeService.run(opts({ env: { ...ENV, VERCEL_ENV: "production" } }), fake.asClient())).rejects.toThrow(FreezeDisabledError);
    expect(counts()).toEqual({ snapshots: 0, artifacts: 0, deliveries: 0 });
  });

  it("run on an already frozen period refuses to finish missing steps (no PDF, handoff.json or Drive upload)", async () => {
    await snapshotOnly();
    const before = counts();
    const o = opts();
    await expect(FreezeService.run(o, fake.asClient())).rejects.toThrow(FreezeDisabledError);
    expect(counts()).toEqual(before);
    expect(fake.state.snapshots[0].pdfStorageKey).toBeNull();
    expect(o.fetch).not.toHaveBeenCalled();
  });

  it("complete (render PDF, write handoff.json, deliver) refuses and writes nothing", async () => {
    const snap = await snapshotOnly();
    const before = counts();
    const o = opts();
    await expect(FreezeService.complete(snap, o, fake.asClient())).rejects.toThrow(FreezeDisabledError);
    expect(counts()).toEqual(before);
    expect(fake.state.snapshots[0].pdfStorageKey).toBeNull();
    expect(o.fetch).not.toHaveBeenCalled();
  });

  it("the cron route answers 403 with the message (GET and POST) and writes nothing", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    for (const handler of [cronGET, cronPOST]) {
      const res = await handler(new Request("https://x/api/cron/freeze", { headers: { authorization: `Bearer ${SECRET}` } }));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: MESSAGE });
    }
    expect(counts()).toEqual({ snapshots: 0, artifacts: 0, deliveries: 0 });
  });

  it("an unauthorized cron call is still 401 on preview", async () => {
    vi.stubEnv("CRON_SECRET", SECRET);
    const res = await cronGET(new Request("https://x/api/cron/freeze", { headers: { authorization: "Bearer wrong" } }));
    expect(res.status).toBe(401);
  });

  it("the Freeze now action returns an error state with the message and writes nothing", async () => {
    h.viewer = Factory.ADMIN as unknown as Viewer;
    expect(await freezeNow()).toEqual({ ok: false, message: MESSAGE });
    expect(counts()).toEqual({ snapshots: 0, artifacts: 0, deliveries: 0 });
  });
});

describe("FreezeService outside preview is unchanged", () => {
  for (const v of [undefined, "production", "development"]) {
    it(`freezes as before with VERCEL_ENV ${v ?? "unset"}`, async () => {
      if (v !== undefined) vi.stubEnv("VERCEL_ENV", v);
      else vi.stubEnv("VERCEL_ENV", undefined as unknown as string);
      const r = await FreezeService.run(opts(), fake.asClient());
      expect(r.outcome).toBe("created");
      expect(fake.state.snapshots).toHaveLength(1);
      expect(fake.state.artifacts.map((a) => a.kind).sort()).toEqual(["handoff", "pdf"]);
      const again = await FreezeService.run(opts(), fake.asClient());
      expect(again.outcome).toBe("already_frozen");
      expect(fake.state.artifacts).toHaveLength(2);
    });
  }

  it("the cron route still freezes with 200 in production", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("CRON_SECRET", SECRET);
    const res = await cronGET(new Request("https://x/api/cron/freeze", { headers: { authorization: `Bearer ${SECRET}` } }));
    expect(res.status).toBe(200);
    expect(["created", "already_frozen", "skipped"]).toContain(((await res.json()) as { outcome: string }).outcome);
  });
});
