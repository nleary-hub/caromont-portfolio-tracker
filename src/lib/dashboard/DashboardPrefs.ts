import type { ProjectStatus, ServiceArea } from "@/generated/prisma/enums";
import { DepartmentFilter } from "@/lib/domain/DepartmentFilter";
import { FiscalYear } from "@/lib/domain/FiscalYear";
import { ProjectStatusInfo } from "@/lib/domain/ProjectStatusInfo";

/** A summary tile: a status count, or the "Completed FY27 to date" card. */
export type DashboardTile = ProjectStatus | "completedFy";

/** Minimal Storage surface (window.localStorage in the browser, a Map in tests). */
export interface PrefsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Per-user dashboard preferences kept in the browser's localStorage (never on the server): the department
 * filter and which summary tiles are shown. Keys include the signed-in email, so two people sharing a
 * browser keep separate choices. Anything unreadable falls back to the defaults (all departments, all tiles).
 */
export class DashboardPrefs {
  static readonly VERSION = 1;
  /** Tiles in display order. Cancelled has no tile. */
  static readonly TILES: readonly DashboardTile[] = ["NotStarted", "OnTrack", "AtRisk", "OffTrack", "OnHold", "Complete", "completedFy"];
  static readonly TILES_TOOLTIP = "Show or hide tiles";
  static readonly SHOW_ALL = "Show all";

  static departmentsKey(email: string): string {
    return `pt:v${DashboardPrefs.VERSION}:dashboard:departments:${email.trim().toLowerCase()}`;
  }

  static hiddenTilesKey(email: string): string {
    return `pt:v${DashboardPrefs.VERSION}:dashboard:hidden-tiles:${email.trim().toLowerCase()}`;
  }

  private static parse(text: string | null): unknown {
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  static readDepartments(storage: PrefsStorage | null, email: string): ServiceArea[] {
    return DepartmentFilter.normalize(storage ? DashboardPrefs.parse(storage.getItem(DashboardPrefs.departmentsKey(email))) : null);
  }

  static writeDepartments(storage: PrefsStorage | null, email: string, selection: readonly ServiceArea[]): void {
    storage?.setItem(DashboardPrefs.departmentsKey(email), JSON.stringify(DepartmentFilter.normalize(selection)));
  }

  /** Hidden tiles are stored (not shown ones), so a tile added later starts visible. */
  static readHiddenTiles(storage: PrefsStorage | null, email: string): DashboardTile[] {
    const raw = storage ? DashboardPrefs.parse(storage.getItem(DashboardPrefs.hiddenTilesKey(email))) : null;
    return Array.isArray(raw) ? DashboardPrefs.TILES.filter((t) => raw.includes(t)) : [];
  }

  static writeHiddenTiles(storage: PrefsStorage | null, email: string, hidden: readonly DashboardTile[]): void {
    storage?.setItem(DashboardPrefs.hiddenTilesKey(email), JSON.stringify(DashboardPrefs.TILES.filter((t) => hidden.includes(t))));
  }

  /** Tiles available now (the FY card only when its count loaded), in display order. */
  static availableTiles(hasFiscalYear: boolean): DashboardTile[] {
    return DashboardPrefs.TILES.filter((t) => t !== "completedFy" || hasFiscalYear);
  }

  static visibleTiles(hidden: readonly DashboardTile[], hasFiscalYear: boolean): DashboardTile[] {
    return DashboardPrefs.availableTiles(hasFiscalYear).filter((t) => !hidden.includes(t));
  }

  static toggleTile(hidden: readonly DashboardTile[], tile: DashboardTile, show: boolean): DashboardTile[] {
    const next = show ? hidden.filter((t) => t !== tile) : [...hidden, tile];
    return DashboardPrefs.TILES.filter((t) => next.includes(t));
  }

  /** Remaining tiles share the row equally, in order. Null when every tile is off (no tile row). */
  static gridTemplate(visible: readonly DashboardTile[]): string | null {
    return visible.length ? `repeat(${visible.length}, minmax(0, 1fr))` : null;
  }

  static tileLabel(tile: DashboardTile, fiscalYearLabel: string | null): string {
    if (tile === "completedFy") return fiscalYearLabel ? FiscalYear.completedLabel(fiscalYearLabel) : "Completed this fiscal year";
    return ProjectStatusInfo.label(tile);
  }
}
