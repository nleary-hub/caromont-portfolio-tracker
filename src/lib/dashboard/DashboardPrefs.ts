import type { DepartmentKey, DepartmentList } from "@/lib/domain/ServiceAreaInfo";
import type { ProjectStatus } from "@/generated/prisma/enums";
import { DepartmentFilter } from "@/lib/domain/DepartmentFilter";
import { FiscalYear } from "@/lib/domain/FiscalYear";
import { ProjectStatusInfo } from "@/lib/domain/ProjectStatusInfo";

/** A summary tile: a status count, or the "Completed FY27 to date" card. */
export type DashboardTile = ProjectStatus | "completedFy";

/** The service line prefs belong to. Absent = the default line (CVPSL), which keeps the original keys. */
export interface PrefsLine {
  id: string;
  isDefault: boolean;
  departments: DepartmentList;
}

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

  /** Keys are per line: the default line keeps the original key, other lines add ":sl:<line id>". */
  static departmentsKey(email: string, line?: PrefsLine): string {
    return `pt:v${DashboardPrefs.VERSION}:dashboard:departments:${email.trim().toLowerCase()}${DashboardPrefs.lineSuffix(line)}`;
  }

  static hiddenTilesKey(email: string, line?: PrefsLine): string {
    return `pt:v${DashboardPrefs.VERSION}:dashboard:hidden-tiles:${email.trim().toLowerCase()}${DashboardPrefs.lineSuffix(line)}`;
  }

  private static lineSuffix(line: PrefsLine | undefined): string {
    return !line || line.isDefault ? "" : `:sl:${line.id}`;
  }

  /** The department filter's options for the line. */
  static options(line?: PrefsLine): readonly DepartmentKey[] {
    return line ? DepartmentFilter.optionsFor(line) : DepartmentFilter.OPTIONS;
  }

  private static parse(text: string | null): unknown {
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  static readDepartments(storage: PrefsStorage | null, email: string, line?: PrefsLine): DepartmentKey[] {
    // Saved before migration 0018: old enum values, read as the departments that replaced them.
    return DepartmentFilter.fromStored(
      storage ? DashboardPrefs.parse(storage.getItem(DashboardPrefs.departmentsKey(email, line))) : null,
      DashboardPrefs.options(line),
      line?.departments,
    );
  }

  /** Excluded departments are stored (not included ones), so a department added later starts included. */
  static writeDepartments(storage: PrefsStorage | null, email: string, selection: readonly DepartmentKey[], line?: PrefsLine): void {
    storage?.setItem(DashboardPrefs.departmentsKey(email, line), JSON.stringify(DepartmentFilter.toStored(selection, DashboardPrefs.options(line))));
  }

  /** Hidden tiles are stored (not shown ones), so a tile added later starts visible. */
  static readHiddenTiles(storage: PrefsStorage | null, email: string, line?: PrefsLine): DashboardTile[] {
    const raw = storage ? DashboardPrefs.parse(storage.getItem(DashboardPrefs.hiddenTilesKey(email, line))) : null;
    return Array.isArray(raw) ? DashboardPrefs.TILES.filter((t) => raw.includes(t)) : [];
  }

  static writeHiddenTiles(storage: PrefsStorage | null, email: string, hidden: readonly DashboardTile[], line?: PrefsLine): void {
    storage?.setItem(DashboardPrefs.hiddenTilesKey(email, line), JSON.stringify(DashboardPrefs.TILES.filter((t) => hidden.includes(t))));
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
