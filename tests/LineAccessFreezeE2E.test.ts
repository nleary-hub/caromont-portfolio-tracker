import { afterAll, describe, expect, it, vi } from "vitest";

/**
 * Frank's e2e (item 8): the Tuesday freeze on a real Postgres database with migration 0023 applied and access
 * enforcement on, nobody signed in and nobody given access. Runs the real cron route handler end to end (Prisma,
 * PDF render, handoff.json, Drive delivery with Google stubbed at fetch, signed share link route).
 * Local only: set E2E_LINE_ACCESS_DB_URL to a scratch database (it is written to); skipped otherwise.
 */
const URL = process.env.E2E_LINE_ACCESS_DB_URL;
const FREEZE_RUN = new Date("2026-09-29T21:30:00Z"); // Tue 9/29 5:30 PM ET
const SECRET = "e".repeat(48);
const ENV = {
  DATABASE_URL: URL ?? "",
  CRON_SECRET: "cron-secret-value-000000000000",
  SHARE_LINK_SECRET: SECRET,
  APP_BASE_URL: "https://tracker.example.org/",
  REPORT_RECIPIENT_EMAIL: "nick.leary@caromonthealth.org",
  GOOGLE_DRIVE_CLIENT_ID: "cid",
  GOOGLE_DRIVE_CLIENT_SECRET: "csecret",
  GOOGLE_DRIVE_REFRESH_TOKEN: "rtoken",
};

describe.skipIf(!URL)("e2e: Tuesday freeze with per-line access on (real Postgres)", () => {
  afterAll(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("stores the PDF and handoff.json, saves both to Drive, sets the archive link; share links serve both", async () => {
    for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
    const { Db } = await import("@/lib/db/Db");
    const { GET: cronGET } = await import("@/app/api/cron/freeze/route");
    const { GET: shareGET } = await import("@/app/api/share/[token]/[file]/route");
    const { SignedLink } = await import("@/lib/report/SignedLink");
    const db = Db.client;

    // Enforcement on: the access tables exist and nobody has any line.
    await db.serviceLineAccessGrant.deleteMany({});
    expect(await db.serviceLineAccessGrant.count()).toBe(0);

    let uploads = 0;
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "Content-Type": "application/json" } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.startsWith("https://oauth2.googleapis.com/token")) return json({ access_token: "at" });
        if (url.startsWith("https://www.googleapis.com/drive/v3/files?")) return json({ files: [{ id: "folder1" }] });
        if (url.startsWith("https://www.googleapis.com/upload/drive/v3/files")) return json({ id: `file${++uploads}` });
        throw new Error(`unexpected fetch ${url}`);
      }),
    );
    vi.useFakeTimers({ toFake: ["Date"], now: FREEZE_RUN });

    const res = await cronGET(new Request("https://tracker.example.org/api/cron/freeze", { headers: { authorization: `Bearer ${ENV.CRON_SECRET}` } }));
    const body = (await res.json()) as { outcome: string; snapshotId: string; delivery: string };
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ outcome: "created", delivery: "drive" });
    expect(uploads).toBe(2);

    const arts = await db.reportArtifact.findMany({ where: { snapshotId: body.snapshotId }, orderBy: { kind: "desc" } });
    expect(arts.map((a) => [a.kind, a.fileName])).toEqual([
      ["pdf", "cardiac-portfolio-report-2026-09-29.pdf"],
      ["handoff", "handoff-2026-09-29.json"],
    ]);
    const handoff = JSON.parse(Buffer.from(arts[1].bytes).toString("utf8")) as { archiveUrl: string; snapshotId: string };
    expect(handoff).toMatchObject({ archiveUrl: "https://tracker.example.org/reports", snapshotId: body.snapshotId });
    const deliveries = await db.reportDelivery.findMany({ where: { snapshotId: body.snapshotId } });
    expect(deliveries.map((d) => [d.method, d.status])).toEqual([["drive", "ok"]]);

    const token = SignedLink.sign(body.snapshotId, new Date("2026-10-06T21:00:00Z"), SECRET);
    for (const file of ["pdf", "handoff"]) {
      const r = await shareGET(new Request("https://tracker.example.org/"), { params: Promise.resolve({ token, file }) });
      expect(r.status, file).toBe(200);
    }
    await db.$disconnect();
  }, 120000);
});
