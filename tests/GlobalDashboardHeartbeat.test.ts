import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccountMenu } from "@/components/AccountMenu";
import { AuthStage } from "@/components/AuthStage";
import { ProjectDashboard } from "@/components/ProjectDashboard";
import { DashboardViewModel } from "@/lib/dashboard/DashboardViewModel";
import { ServiceLine } from "@/lib/domain/ServiceLine";
import { ViewSettings } from "@/lib/domain/ViewSettings";
import {
  DashboardSettingsService,
  type DashboardSettingsDb,
} from "@/lib/services/DashboardSettingsService";
import { Factory } from "./helpers/factories";

// Oct 22, 2026: the Dashboard heartbeat is one global admin setting (migration 0067), default off. Fictional data only.
const viewer = vi.hoisted(() => ({
  current: null as null | {
    email: string;
    isAdmin: boolean;
    name: string | null;
  },
}));
vi.mock("@/lib/auth/CurrentViewer", () => ({
  CurrentViewer: { get: async () => viewer.current },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

class FakeSettings implements DashboardSettingsDb {
  row: { id: string; heartbeat: boolean; updatedBy: string } | null = null;
  upserts = 0;
  dashboardSettings = {
    findUnique: async () => this.row,
    upsert: async (a: {
      create: { id: string; heartbeat: boolean; updatedBy: string };
      update: { heartbeat: boolean; updatedBy: string };
    }) => {
      this.upserts++;
      this.row = this.row ? { ...this.row, ...a.update } : { ...a.create };
      return this.row;
    },
  };
}

describe("global Dashboard heartbeat setting", () => {
  let db: FakeSettings;
  beforeEach(() => {
    db = new FakeSettings();
    viewer.current = null;
  });

  it("with no row, the heartbeat is off (and a read failure or unmigrated database is off too)", async () => {
    expect(DashboardSettingsService.HEARTBEAT_DEFAULT).toBe(false);
    expect(await DashboardSettingsService.heartbeat(db)).toBe(false);
    expect(
      await DashboardSettingsService.heartbeat({} as DashboardSettingsDb),
    ).toBe(false);
    const broken = {
      dashboardSettings: {
        findUnique: async () => Promise.reject(new Error("no table")),
        upsert: async () => ({ heartbeat: true }),
      },
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await DashboardSettingsService.heartbeat(broken)).toBe(false);
  });

  it("non-admins can't set it (service and server action both refuse; nothing is written)", async () => {
    await expect(
      DashboardSettingsService.setHeartbeat(
        { email: "kim.sample@example.org", isAdmin: false },
        true,
        db,
      ),
    ).rejects.toThrow(/admins/);
    await expect(
      DashboardSettingsService.setHeartbeat(null, true, db),
    ).rejects.toThrow(/admins/);
    expect(db.upserts).toBe(0);
    const set = vi.spyOn(DashboardSettingsService, "setHeartbeat");
    const { setGlobalDashboardHeartbeat } =
      await import("@/app/actions/dashboardSettings");
    expect(await setGlobalDashboardHeartbeat(true)).toBeNull(); // signed out
    viewer.current = {
      email: "kim.sample@example.org",
      isAdmin: false,
      name: "Kim Sample",
    };
    expect(await setGlobalDashboardHeartbeat(true)).toBeNull();
    expect(set).not.toHaveBeenCalled();
    set.mockRestore();
  });

  it("an admin can turn it on and off; the server action re-checks admin before saving", async () => {
    expect(
      await DashboardSettingsService.setHeartbeat(
        { email: "pat.admin@example.org", isAdmin: true },
        true,
        db,
      ),
    ).toBe(true);
    expect(await DashboardSettingsService.heartbeat(db)).toBe(true);
    expect(db.row?.updatedBy).toBe("pat.admin@example.org");
    expect(
      await DashboardSettingsService.setHeartbeat(
        { email: "pat.admin@example.org", isAdmin: true },
        false,
        db,
      ),
    ).toBe(false);
    await expect(
      DashboardSettingsService.setHeartbeat(
        { email: "pat.admin@example.org", isAdmin: true },
        "on",
        db,
      ),
    ).rejects.toThrow(TypeError);
    const set = vi
      .spyOn(DashboardSettingsService, "setHeartbeat")
      .mockResolvedValue(true);
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { setGlobalDashboardHeartbeat } =
      await import("@/app/actions/dashboardSettings");
    viewer.current = {
      email: "pat.admin@example.org",
      isAdmin: true,
      name: "Pat Admin",
    };
    expect(await setGlobalDashboardHeartbeat(true)).toBe(true);
    expect(set).toHaveBeenCalledWith(viewer.current, true);
    set.mockRestore();
  });

  const rows = DashboardViewModel.rows(
    [Factory.project({ id: "a", name: "Alpha", status: "OnTrack" })],
    ViewSettings.defaults("dashboard"),
    [],
    null,
    "2026-10-04",
  );
  const dash = (heartbeat?: boolean) =>
    renderToStaticMarkup(
      createElement(ProjectDashboard, {
        rows,
        columns: ViewSettings.visibleColumns(
          ViewSettings.defaults("dashboard"),
        ),
        today: "2026-10-04",
        userEmail: "kim.sample@example.org",
        userName: "Kim Sample",
        latestReport: null,
        completedFiscalYear: { label: "FY27", start: "2026-07-01", count: 4 },
        loadError: null,
        serviceLine: ServiceLine.defaults(),
        signOutAction: async () => {},
        ...(heartbeat === undefined ? {} : { heartbeat }),
      }),
    );

  it("with it on, it renders for a non-admin viewer; with no value it is off", () => {
    const on = dash(true); // no admin prop: a limited, non-admin viewer
    expect(on).toContain('class="pb-ecg"');
    expect(on).toContain("pb-tile-beat");
    for (const html of [dash(), dash(false)]) {
      for (const gone of ["pb-ecg", "pb-tile-beat"])
        expect(html, gone).not.toContain(gone);
      expect(html).toContain("pb-grid");
    }
  });

  it("the dashboard page reads the global value, not the per-person preference", () => {
    const page = readFileSync("src/app/page.tsx", "utf8");
    expect(page).toContain(
      "heartbeat={await DashboardSettingsService.heartbeat()}",
    );
    expect(page).not.toContain("DashboardPrefsService");
    expect(page).not.toContain("setHeartbeatAction");
  });

  it("the account menu has no switch", () => {
    const src = readFileSync("src/components/AccountMenu.tsx", "utf8");
    expect(src).not.toContain('role="switch"');
    expect(src).not.toContain("HeartbeatCopy");
    const html = renderToStaticMarkup(
      createElement(AccountMenu, { name: "Kim Sample" }),
    );
    expect(html).toContain("Kim Sample");
    expect(html).not.toMatch(/switch|heartbeat/i);
  });

  it("the sign-in render is unchanged (AuthStage markup pinned to main)", () => {
    const html = renderToStaticMarkup(
      createElement(AuthStage, {
        state: "error",
        children: createElement("p", null, "Sample"),
      }),
    );
    expect(createHash("sha256").update(html).digest("hex")).toBe(
      "ec1f6a890608e94eafb83b476e4e9cca79371110fc6146b2bb9ddfe50dc03241",
    );
  });

  it("migration 0067 is add-only: one table, heartbeat defaults to false, no row inserted, nothing dropped", async () => {
    const dir = path.resolve(
      __dirname,
      "../prisma/migrations/0067_dashboard_heartbeat_setting/migration.sql",
    );
    const sql = readFileSync(dir, "utf8");
    const code = sql
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    expect(code).not.toMatch(/\b(DROP|DELETE|UPDATE|INSERT|ALTER)\b/i);
    expect(sql).not.toMatch(/\u2014/);
    const pg = await PGlite.create();
    await pg.exec(sql);
    await pg.exec(sql); // idempotent
    expect(
      (await pg.query("SELECT count(*)::int AS n FROM dashboard_settings"))
        .rows[0],
    ).toEqual({ n: 0 });
    await pg.exec(
      `INSERT INTO dashboard_settings ("updatedBy") VALUES ('pat.admin@example.org')`,
    );
    expect(
      (await pg.query("SELECT id, heartbeat FROM dashboard_settings")).rows[0],
    ).toEqual({ id: "dashboard", heartbeat: false });
  });
});
