import { readFileSync } from "node:fs";
import path from "node:path";
import { prerender } from "react-dom/static";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { FakeDb } from "./helpers/FakeDb";
import { Factory } from "./helpers/factories";

// Regression: the report archive crashed for admins when a snapshot's delivery was "signed_link" without link
// details ({"status":"signed_link"}, the shape in the production-shaped fixture): the page read
// signedLink!.expiresAt. The page is rendered for real here with the viewer and Db swapped for fakes.
const h = vi.hoisted(() => ({ viewer: null as Viewer | null, db: null as unknown }));
vi.mock("@/lib/auth/CurrentViewer", () => ({ CurrentViewer: { get: async () => h.viewer } }));
vi.mock("@/lib/db/Db", () => ({ Db: { get client() { return h.db; }, isConfigured: () => true } }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => "/reports",
}));
// The page's sign-out action (per-line access) imports @/auth; next-auth is not loaded in tests.
vi.mock("@/auth", () => ({ auth: async () => null, signIn: async () => {}, signOut: async () => {}, SIGN_IN_PATH: "/signin", handlers: {} }));

const { default: ReportsPage } = await import("@/app/reports/page");
const { ReportDeliveryService } = await import("@/lib/services/ReportDeliveryService");
const { ArchiveDeliveryText } = await import("@/lib/report/ArchiveDeliveryText");

const FIXTURE = readFileSync(path.resolve(__dirname, "fixtures/prod-shape-0015.sql"), "utf8");

class Fx {
  static snapshot(id: string, periodEnd: string, deliveryJson: unknown) {
    return {
      id,
      periodStart: new Date(`${periodEnd}T00:00:00Z`),
      periodEnd: new Date(`${periodEnd}T00:00:00Z`),
      generatedAt: new Date(`${periodEnd}T21:30:00Z`),
      generatedBy: "cron",
      rowsJson: [],
      missingChampionsJson: [],
      pdfStorageKey: null,
      deliveryJson,
    };
  }

  static async render(): Promise<string> {
    // prerender waits for the async server components inside the page (the service line and admin menu slots).
    const { prelude } = await prerender(await ReportsPage({ searchParams: Promise.resolve({}) }));
    return await new Response(prelude).text();
  }
}

let fake: FakeDb;
beforeEach(() => {
  fake = new FakeDb();
  h.db = fake.asClient();
});
afterEach(() => {
  h.viewer = null;
});

describe("Report archive: signed-link delivery without link details", () => {
  it("the production-shaped fixture really has that shape", () => {
    expect(FIXTURE).toMatch(/\{"status":"signed_link"\}/);
  });

  it("parse keeps the status and drops incomplete link details (no throw, no fake link)", () => {
    expect(ReportDeliveryService.parse({ status: "signed_link" })).toMatchObject({ status: "signed_link" });
    expect(ReportDeliveryService.parse({ status: "signed_link" })!.signedLink).toBeUndefined();
    expect(ReportDeliveryService.parse({ status: "signed_link", signedLink: null })!.signedLink).toBeUndefined();
    expect(ReportDeliveryService.parse({ status: "signed_link", signedLink: { pdfUrl: "/api/share/x/pdf" } })!.signedLink).toBeUndefined();
    expect(ReportDeliveryService.parse({ status: "signed_link", signedLink: { pdfUrl: "/p", expiresAt: "not a date" } })!.signedLink).toBeUndefined();
    const full = { status: "signed_link", attemptedAt: "2026-09-29T21:30:00.000Z", triggeredBy: "cron", signedLink: { pdfUrl: "/p", handoffUrl: "/h", expiresAt: "2026-10-06T21:30:00.000Z" } };
    expect(ReportDeliveryService.parse(full)).toEqual(full);
    expect(ReportDeliveryService.parse({ status: "drive" })!.drive).toBeUndefined();
    expect(ReportDeliveryService.parse(null)).toBeNull();
    expect(ReportDeliveryService.parse([])).toBeNull();
    expect(ReportDeliveryService.parse({})).toBeNull();
  });

  it("the freeze's redelivery decision is unchanged for partial records", () => {
    const drive = { GOOGLE_DRIVE_CLIENT_ID: "a", GOOGLE_DRIVE_CLIENT_SECRET: "b", GOOGLE_DRIVE_REFRESH_TOKEN: "c", GOOGLE_DRIVE_FOLDER_ID: "d" };
    for (const env of [{}, drive]) {
      for (const json of [{ status: "signed_link" }, { status: "drive" }, { status: "failed" }, { status: "other" }]) {
        const before = json as unknown as Parameters<typeof ReportDeliveryService.needsDelivery>[0];
        expect(ReportDeliveryService.needsDelivery(ReportDeliveryService.parse(json), env), JSON.stringify(json)).toBe(ReportDeliveryService.needsDelivery(before, env));
      }
    }
  });

  it("labels: missing details read as issued without details; a full link keeps its date and anchor", () => {
    expect(ArchiveDeliveryText.label(ReportDeliveryService.parse({ status: "signed_link" }))).toBe("Signed link issued (link details missing)");
    expect(ArchiveDeliveryText.linkHref(ReportDeliveryService.parse({ status: "signed_link" }))).toBeNull();
    const full = ReportDeliveryService.parse({ status: "signed_link", signedLink: { pdfUrl: "/p", handoffUrl: "/h", expiresAt: "2026-10-06T21:30:00.000Z" } });
    expect(ArchiveDeliveryText.label(full)).toMatch(/^Signed link until Oct 6, 2026/);
    expect(ArchiveDeliveryText.linkHref(full)).toBe("/p");
    expect(ArchiveDeliveryText.label(null)).toBe("Not delivered yet");
    expect(ArchiveDeliveryText.label(ReportDeliveryService.parse({ status: "drive" }))).toBe("Uploaded to Google Drive");
    expect(ArchiveDeliveryText.label(ReportDeliveryService.parse({ status: "failed" }))).toBe("Delivery failed");
    // Even a record that skipped parse never throws.
    expect(() => ArchiveDeliveryText.label({ status: "signed_link", attemptedAt: "", triggeredBy: "", signedLink: { pdfUrl: "/p", handoffUrl: "", expiresAt: "bad" } })).not.toThrow();
  });

  it("the /reports page renders for an admin with the fixture's delivery shapes (was a crash)", async () => {
    h.viewer = Factory.ADMIN;
    fake.state.snapshots.push(
      Fx.snapshot("90000000-0000-4000-8000-000000000001", "2026-09-08", { status: "drive" }),
      Fx.snapshot("90000000-0000-4000-8000-000000000002", "2026-09-15", { status: "signed_link" }),
      Fx.snapshot("90000000-0000-4000-8000-000000000003", "2026-09-22", {
        status: "signed_link",
        signedLink: { pdfUrl: "https://example.org/api/share/t/pdf", handoffUrl: "https://example.org/api/share/t/handoff", expiresAt: "2026-09-29T21:30:00.000Z" },
      }),
    );
    const html = await Fx.render();
    expect(html).toContain("Report archive");
    expect(html).toContain("Signed link issued (link details missing)");
    expect(html).toContain("Uploaded to Google Drive");
    expect(html).toMatch(/Signed link until Sep 29, 2026/);
    expect(html.match(/>link<\/a>/g)).toHaveLength(1);
  });
});
