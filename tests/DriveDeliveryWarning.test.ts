import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { FakeDb } from "./helpers/FakeDb";
import { Factory } from "./helpers/factories";

// Drive saves failed every day from Oct 13, 2026 (Google answered invalid_grant: the refresh token had expired) and the
// only sign was "Signed link until ..." in the archive. These pin the Owner's warning banner and the Sentry alert.
const h = vi.hoisted(() => ({ viewer: null as Viewer | null, db: null as unknown, capture: vi.fn() }));
vi.mock("@sentry/nextjs", () => ({ captureMessage: h.capture }));
vi.mock("@/lib/auth/CurrentViewer", () => ({ CurrentViewer: { get: async () => h.viewer } }));
vi.mock("@/lib/db/Db", () => ({ Db: { get client() { return h.db; }, isConfigured: () => true } }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
  notFound: () => {
    throw new Error("notFound");
  },
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => "/reports",
}));
vi.mock("@/auth", () => ({ auth: async () => null, signIn: async () => {}, signOut: async () => {}, SIGN_IN_PATH: "/signin", handlers: {} }));

const { prerender } = await import("react-dom/static");
const { default: ReportsPage } = await import("@/app/reports/page");
const { DriveDeliveryWarning } = await import("@/lib/report/DriveDeliveryWarning");
const { DriveError } = await import("@/lib/report/GoogleDriveClient");
const { ReportAlert } = await import("@/lib/report/ReportAlert");
const { ReportDeliveryService } = await import("@/lib/services/ReportDeliveryService");

const EXPIRED = 'Token refresh failed (HTTP 400): {\n  "error": "invalid_grant",\n  "error_description": "Token has been expired or revoked."\n}';
const LINK = { pdfUrl: "https://example.org/api/share/t/pdf", handoffUrl: "https://example.org/api/share/t/handoff", expiresAt: "2026-11-03T22:19:42.000Z" };
const newest = (delivery: unknown) => ({ periodStart: "2026-10-13", periodEnd: "2026-10-27", delivery: ReportDeliveryService.parse(delivery) });

beforeEach(() => {
  vi.stubEnv("OWNER_EMAIL", "admin@example.org");
  h.capture.mockReset();
});
afterEach(() => {
  h.viewer = null;
  vi.restoreAllMocks();
});

describe("DriveDeliveryWarning", () => {
  it("expired Drive sign-in: names the cause, the stale Wednesday email and the fix", () => {
    const w = DriveDeliveryWarning.from(newest({ status: "signed_link", attemptedAt: "2026-11-03T22:19:42.000Z", triggeredBy: "cron", driveError: EXPIRED, signedLink: LINK }))!;
    expect(w.title).toBe(DriveDeliveryWarning.EXPIRED_TITLE);
    expect(w.body).toContain("Oct 13 – Oct 27, 2026");
    expect(w.body).toContain("went out only as a signed link");
    expect(w.body).toContain("Wednesday email");
    expect(w.body).toMatch(/Last tried Nov 3, 2026/);
    expect(w.body).toContain("GOOGLE_DRIVE_REFRESH_TOKEN");
    expect(w.body).toContain("publish it first");
    expect(w.detail).toBe(EXPIRED);
  });

  it("any other Drive error gets the general warning", () => {
    const w = DriveDeliveryWarning.from(newest({ status: "signed_link", attemptedAt: "x", triggeredBy: "cron", driveError: "Upload of a.pdf failed (HTTP 403)", signedLink: LINK }))!;
    expect(w.title).toBe(DriveDeliveryWarning.FAILED_TITLE);
    expect(w.body).toContain(DriveDeliveryWarning.FAILED_FIX);
    expect(w.body).not.toContain("Last tried"); // a bad attemptedAt is left out, never "Invalid Date"
  });

  it("nothing delivered at all is a warning too", () => {
    const w = DriveDeliveryWarning.from(newest({ status: "failed", attemptedAt: "2026-11-03T22:19:42.000Z", triggeredBy: "cron", driveError: EXPIRED, signedLinkError: "SHARE_LINK_SECRET is not set" }))!;
    expect(w.body).toContain("wasn't delivered at all");
  });

  it("no warning when the newest report is in Drive, not delivered yet, or Drive is deliberately unset", () => {
    expect(DriveDeliveryWarning.from(newest({ status: "drive" }))).toBeNull();
    expect(DriveDeliveryWarning.from(newest(null))).toBeNull();
    expect(DriveDeliveryWarning.from(null)).toBeNull();
    expect(DriveDeliveryWarning.from(newest({ status: "signed_link", driveError: ReportDeliveryService.NOT_CONFIGURED, signedLink: LINK }))).toBeNull();
    // Unset Drive AND no signed link: nothing went out, so that still warns.
    expect(DriveDeliveryWarning.from(newest({ status: "failed", driveError: ReportDeliveryService.NOT_CONFIGURED }))).not.toBeNull();
  });

  it("DriveError.isExpiredSignIn spots Google's invalid_grant answer only", () => {
    expect(DriveError.isExpiredSignIn(EXPIRED)).toBe(true);
    expect(DriveError.isExpiredSignIn("Upload failed (HTTP 500)")).toBe(false);
    expect(DriveError.isExpiredSignIn(undefined)).toBe(false);
  });
});

describe("ReportAlert", () => {
  it("one Sentry issue for every Drive failure (fixed fingerprint), no error text in the message", () => {
    ReportAlert.driveSaveFailed(EXPIRED);
    ReportAlert.driveSaveFailed("Upload of a.pdf failed (HTTP 403)");
    expect(h.capture).toHaveBeenCalledTimes(2);
    const [[m1, o1], [m2, o2]] = h.capture.mock.calls as [string, { fingerprint: string[]; level: string; tags: Record<string, string> }][];
    expect(m1).toBe(ReportAlert.DRIVE_EXPIRED);
    expect(o1.tags.reason).toBe("expired_sign_in");
    expect(m2).toBe(ReportAlert.DRIVE_FAILED);
    expect(o1.fingerprint).toEqual(o2.fingerprint);
    expect(o1.level).toBe("error");
    expect(m1).not.toContain("invalid_grant");
  });

  it("a throwing Sentry never breaks delivery", () => {
    expect(() => ReportAlert.driveSaveFailed(EXPIRED, () => { throw new Error("sentry down"); })).not.toThrow();
  });

  it("the delivery raises the alert when Drive fails and still issues the signed link", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    const fake = new FakeDb();
    const db = fake.asClient();
    const file = (name: string) => ({ fileName: name, contentType: "application/pdf", bytes: new Uint8Array([1]) }) as never;
    const env = { GOOGLE_DRIVE_CLIENT_ID: "a", GOOGLE_DRIVE_CLIENT_SECRET: "b", GOOGLE_DRIVE_REFRESH_TOKEN: "c", SHARE_LINK_SECRET: "x".repeat(48), APP_BASE_URL: "https://t.example.org" };
    fake.state.snapshots.push({ id: "90000000-0000-4000-8000-000000000009", deliveryJson: null } as never);
    const r = await ReportDeliveryService.deliver(
      "90000000-0000-4000-8000-000000000009",
      { pdf: file("r.pdf"), handoff: file("h.json") },
      "cron",
      { env, fetch: vi.fn(async () => new Response('{"error":"invalid_grant"}', { status: 400 })), now: new Date("2026-11-03T22:19:42Z") },
      db,
    );
    expect(r.status).toBe("signed_link");
    expect(h.capture).toHaveBeenCalledTimes(1);
    expect(h.capture.mock.calls[0][0]).toBe(ReportAlert.DRIVE_EXPIRED);
  });
});

describe("/reports: the Owner's Drive warning", () => {
  const snap = (id: string, periodEnd: string, deliveryJson: unknown) => ({
    id,
    periodStart: new Date("2026-10-13T00:00:00Z"),
    periodEnd: new Date(`${periodEnd}T00:00:00Z`),
    generatedAt: new Date(`${periodEnd}T21:01:00Z`),
    generatedBy: "cron",
    rowsJson: [],
    missingChampionsJson: [],
    pdfStorageKey: null,
    deliveryJson,
  });
  const render = async () => {
    const { prelude } = await prerender(await ReportsPage({ searchParams: Promise.resolve({}) }));
    return await new Response(prelude).text();
  };

  it("shows when the newest report fell back to the signed link, and goes away once it is in Drive", async () => {
    h.viewer = Factory.ADMIN;
    const fake = new FakeDb();
    h.db = fake.asClient();
    fake.state.snapshots.push(
      snap("90000000-0000-4000-8000-000000000001", "2026-10-13", { status: "drive" }),
      snap("90000000-0000-4000-8000-000000000002", "2026-10-27", { status: "signed_link", attemptedAt: "2026-11-03T22:19:42.000Z", triggeredBy: "cron", driveError: EXPIRED, signedLink: LINK }),
    );
    let html = await render();
    expect(html).toContain('data-testid="drive-delivery-warning"');
    expect(html).toContain("sign-in for Drive has expired");

    (fake.state.snapshots[1] as { deliveryJson: unknown }).deliveryJson = { status: "drive" };
    html = await render();
    expect(html).not.toContain('data-testid="drive-delivery-warning"');
  });
});
