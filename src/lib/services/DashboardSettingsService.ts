import { Db } from "@/lib/db/Db";

type SettingsRow = { heartbeat: boolean };
export interface DashboardSettingsDb {
  dashboardSettings: {
    findUnique(args: { where: { id: string } }): Promise<SettingsRow | null>;
    upsert(args: {
      where: { id: string };
      create: { id: string; heartbeat: boolean; updatedBy: string };
      update: { heartbeat: boolean; updatedBy: string };
    }): Promise<SettingsRow>;
  };
}

type HideChangedTagRow = { hideChangedTag: boolean };
export interface HideChangedTagDb {
  dashboardSettings: {
    findUnique(args: { where: { id: string } }): Promise<HideChangedTagRow | null>;
    upsert(args: {
      where: { id: string };
      create: { id: string; hideChangedTag: boolean; updatedBy: string };
      update: { hideChangedTag: boolean; updatedBy: string };
    }): Promise<HideChangedTagRow>;
  };
}

/**
 * Global dashboard settings (migration 0067), one row. Today one: "Dashboard heartbeat" (the summary line, the
 * pb-tile-beat glow and the tiles' beat props), for every user. Off by default: no row, a read failure or an
 * unmigrated database all read as off. Only admins may change it (checked here and in the server action).
 * The old per-person app_user.dashboardHeartbeat is no longer read; this value always wins.
 */
export class DashboardSettingsService {
  static readonly ID = "dashboard";
  static readonly HEARTBEAT_DEFAULT = false;
  static readonly HIDE_CHANGED_TAG_DEFAULT = false;

  static async heartbeat(
    db: DashboardSettingsDb = Db.client as unknown as DashboardSettingsDb,
  ): Promise<boolean> {
    try {
      const row = await db.dashboardSettings?.findUnique({
        where: { id: DashboardSettingsService.ID },
      });
      return row?.heartbeat ?? DashboardSettingsService.HEARTBEAT_DEFAULT;
    } catch (e) {
      console.error(
        "Could not read the dashboard heartbeat setting",
        (e as Error)?.name ?? "error",
      );
      return DashboardSettingsService.HEARTBEAT_DEFAULT;
    }
  }

  /** Admins only. Throws for anyone else, and for a value that is not a boolean. Returns the saved value. */
  static async setHeartbeat(
    viewer: { email: string; isAdmin?: boolean } | null,
    on: unknown,
    db: DashboardSettingsDb = Db.client as unknown as DashboardSettingsDb,
  ): Promise<boolean> {
    if (!viewer?.isAdmin)
      throw new Error("Only admins can change the dashboard heartbeat");
    if (typeof on !== "boolean")
      throw new TypeError("Dashboard heartbeat must be true or false");
    const row = await db.dashboardSettings.upsert({
      where: { id: DashboardSettingsService.ID },
      create: {
        id: DashboardSettingsService.ID,
        heartbeat: on,
        updatedBy: viewer.email,
      },
      update: { heartbeat: on, updatedBy: viewer.email },
    });
    console.info("Dashboard heartbeat changed", {
      on: row.heartbeat,
      by: viewer.email,
    });
    return row.heartbeat;
  }

  /**
   * "Hide Changed tag" (migration 0068): hides the Changed tag on the dashboard table for every user. Display
   * only; the Changed flag, the report freeze and the PDF are untouched. Off by default: no row, a read failure
   * or an unmigrated database all read as off.
   */
  static async hideChangedTag(
    db: HideChangedTagDb = Db.client as unknown as HideChangedTagDb,
  ): Promise<boolean> {
    try {
      const row = await db.dashboardSettings?.findUnique({
        where: { id: DashboardSettingsService.ID },
      });
      return row?.hideChangedTag ?? DashboardSettingsService.HIDE_CHANGED_TAG_DEFAULT;
    } catch (e) {
      console.error(
        "Could not read the hide Changed tag setting",
        (e as Error)?.name ?? "error",
      );
      return DashboardSettingsService.HIDE_CHANGED_TAG_DEFAULT;
    }
  }

  /** Admins only. Throws for anyone else, and for a value that is not a boolean. Returns the saved value. */
  static async setHideChangedTag(
    viewer: { email: string; isAdmin?: boolean } | null,
    on: unknown,
    db: HideChangedTagDb = Db.client as unknown as HideChangedTagDb,
  ): Promise<boolean> {
    if (!viewer?.isAdmin)
      throw new Error("Only admins can change the hide Changed tag setting");
    if (typeof on !== "boolean")
      throw new TypeError("Hide Changed tag must be true or false");
    const row = await db.dashboardSettings.upsert({
      where: { id: DashboardSettingsService.ID },
      create: {
        id: DashboardSettingsService.ID,
        hideChangedTag: on,
        updatedBy: viewer.email,
      },
      update: { hideChangedTag: on, updatedBy: viewer.email },
    });
    const saved = row.hideChangedTag;
    console.info("Hide Changed tag changed", { on: saved, by: viewer.email });
    return saved;
  }
}
