import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DueFlagsDisplay } from "@/components/DashboardTable";
import { ProjectDashboard } from "@/components/ProjectDashboard";
import { DashboardViewModel } from "@/lib/dashboard/DashboardViewModel";
import { DueFlags } from "@/lib/dashboard/StackedCells";
import { ServiceLine } from "@/lib/domain/ServiceLine";
import { ViewSettings } from "@/lib/domain/ViewSettings";
import {
  DashboardSettingsService,
  type HideChangedTagDb,
} from "@/lib/services/DashboardSettingsService";
import { Factory } from "./helpers/factories";

// Oct 22, 2026: "Hide Changed tag" is one global admin setting (migration 0068), default off, display only.
// Fictional data only.
const viewer = vi.hoisted(() => ({
  current: null as null | { email: string; isAdmin: boolean; name: string | null },
}));
vi.mock("@/lib/auth/CurrentViewer", () => ({
  CurrentViewer: { get: async () => viewer.current },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

class FakeSettings implements HideChangedTagDb {
  row: { id: string; hideChangedTag: boolean; updatedBy: string } | null = null;
  upserts = 0;
  dashboardSettings = {
    findUnique: async () => this.row,
    upsert: async (a: {
      create: { id: string; hideChangedTag: boolean; updatedBy: string };
      update: { hideChangedTag: boolean; updatedBy: string };
    }) => {
      this.upserts++;
      this.row = this.row ? { ...this.row, ...a.update } : { ...a.create };
      return this.row;
    },
  };
}

const admin = { email: "pat.admin@example.org", isAdmin: true };

describe("global Hide Changed tag setting", () => {
  let db: FakeSettings;
  beforeEach(() => {
    db = new FakeSettings();
    viewer.current = null;
  });

  it("is off by default: no row, an unmigrated database and a read failure all read as off", async () => {
    expect(DashboardSettingsService.HIDE_CHANGED_TAG_DEFAULT).toBe(false);
    expect(await DashboardSettingsService.hideChangedTag(db)).toBe(false);
    expect(await DashboardSettingsService.hideChangedTag({} as HideChangedTagDb)).toBe(false);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = {
      dashboardSettings: {
        findUnique: async () => Promise.reject(new Error("no column")),
        upsert: async () => ({ hideChangedTag: true }),
      },
    };
    expect(await DashboardSettingsService.hideChangedTag(broken)).toBe(false);
  });

  it("only an admin can toggle it (service and server action both refuse others; nothing is written)", async () => {
    await expect(
      DashboardSettingsService.setHideChangedTag({ email: "kim.sample@example.org", isAdmin: false }, true, db),
    ).rejects.toThrow(/admins/);
    await expect(DashboardSettingsService.setHideChangedTag(null, true, db)).rejects.toThrow(/admins/);
    expect(db.upserts).toBe(0);
    const set = vi.spyOn(DashboardSettingsService, "setHideChangedTag");
    const { setGlobalHideChangedTag } = await import("@/app/actions/dashboardSettings");
    expect(await setGlobalHideChangedTag(true)).toBeNull();
    viewer.current = { email: "kim.sample@example.org", isAdmin: false, name: "Kim Sample" };
    expect(await setGlobalHideChangedTag(true)).toBeNull();
    expect(set).not.toHaveBeenCalled();
    set.mockRestore();
  });

  it("an admin can turn it on and off; a non-boolean is refused; the action re-checks admin", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    expect(await DashboardSettingsService.setHideChangedTag(admin, true, db)).toBe(true);
    expect(await DashboardSettingsService.hideChangedTag(db)).toBe(true);
    expect(db.row?.updatedBy).toBe("pat.admin@example.org");
    expect(await DashboardSettingsService.setHideChangedTag(admin, false, db)).toBe(false);
    expect(await DashboardSettingsService.hideChangedTag(db)).toBe(false);
    await expect(DashboardSettingsService.setHideChangedTag(admin, "on", db)).rejects.toThrow(TypeError);
    const set = vi.spyOn(DashboardSettingsService, "setHideChangedTag").mockResolvedValue(true);
    const { setGlobalHideChangedTag } = await import("@/app/actions/dashboardSettings");
    viewer.current = { ...admin, name: "Pat Admin" };
    expect(await setGlobalHideChangedTag(true)).toBe(true);
    expect(set).toHaveBeenCalledWith(viewer.current, true);
    set.mockRestore();
  });

  const rows = DashboardViewModel.rows(
    [Factory.project({ id: "a", name: "Sample Clinic Refresh", status: "OnTrack" })],
    ViewSettings.defaults("dashboard"),
    [],
    null,
    "2026-10-04",
  ).map((r) => ({ ...r, changed: true }));
  const dash = (hideChangedTag?: boolean) =>
    renderToStaticMarkup(
      createElement(ProjectDashboard, {
        rows,
        columns: ViewSettings.visibleColumns(ViewSettings.defaults("dashboard")),
        today: "2026-10-04",
        userEmail: "kim.sample@example.org",
        userName: "Kim Sample",
        latestReport: null,
        completedFiscalYear: null,
        loadError: null,
        serviceLine: ServiceLine.defaults(),
        signOutAction: async () => {},
        ...(hideChangedTag === undefined ? {} : { hideChangedTag }),
      }),
    );

  it("the Changed tag shows by default and with the setting off, and is hidden with it on", () => {
    for (const html of [dash(), dash(false)]) expect(html).toContain('data-flag="changed"');
    const on = dash(true);
    expect(on).not.toContain('data-flag="changed"');
    expect(on).not.toContain('data-part="changed-cue"');
    expect(on).toContain("Sample Clinic Refresh");
  });

  it("display only: the Changed slot keeps its place, the row stays changed, other flags are untouched", () => {
    const row = { ...rows[0], changed: true, overdue: true, dueDate: "2026-09-01" };
    const cell = DueFlags.cell(row, { due: true, flags: true }, "2026-10-04");
    expect(DueFlagsDisplay.withoutChanged(cell, false)).toBe(cell);
    const hidden = DueFlagsDisplay.withoutChanged(cell, true);
    expect(hidden.slots?.length).toBe(cell.slots?.length);
    expect(hidden.slots?.find((s) => s.kind === "changed")?.flag).toBeNull();
    expect(hidden.slots?.find((s) => s.kind === "overdue")?.flag).not.toBeNull();
    expect(row.changed).toBe(true);
  });

  it("the purple left rule is gone: a Changed row's project cell has no lilac inset shadow", () => {
    const src = readFileSync("src/components/DashboardTable.tsx", "utf8");
    expect(src).not.toContain("inset_2px_0_0_#B9A3FF");
    expect(dash()).not.toContain("inset_2px_0_0");
  });

  it("the dashboard page and Admin settings read the global value", () => {
    expect(readFileSync("src/app/page.tsx", "utf8")).toContain(
      "hideChangedTag={await DashboardSettingsService.hideChangedTag()}",
    );
    const admin = readFileSync("src/app/admin/settings/page.tsx", "utf8");
    expect(admin).toContain("<HideChangedTagSetting");
    expect(admin.indexOf("<HideChangedTagSetting")).toBeGreaterThan(admin.indexOf('id="dashboard-settings"'));
  });

  it("migration 0068 is add-only: one column, default false, no row inserted, nothing dropped", async () => {
    const dir = path.resolve(__dirname, "../prisma/migrations");
    const sql67 = readFileSync(path.join(dir, "0067_dashboard_heartbeat_setting/migration.sql"), "utf8");
    const sql = readFileSync(path.join(dir, "0068_hide_changed_tag_setting/migration.sql"), "utf8");
    const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(code).not.toMatch(/\b(DROP|DELETE|UPDATE|INSERT|CREATE)\b/i);
    expect(code).toMatch(/ADD COLUMN IF NOT EXISTS "hideChangedTag" BOOLEAN NOT NULL DEFAULT false/);
    expect(sql).not.toMatch(/\u2014/);
    const pg = await PGlite.create();
    await pg.exec(sql67);
    await pg.exec(`INSERT INTO dashboard_settings ("updatedBy", heartbeat) VALUES ('pat.admin@example.org', true)`);
    await pg.exec(sql);
    await pg.exec(sql); // idempotent
    expect((await pg.query("SELECT id, heartbeat, \"hideChangedTag\" FROM dashboard_settings")).rows).toEqual([
      { id: "dashboard", heartbeat: true, hideChangedTag: false },
    ]);
  });
});
