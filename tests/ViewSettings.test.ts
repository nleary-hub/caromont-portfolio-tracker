import { describe, expect, it } from "vitest";
import { ViewSettings } from "@/lib/domain/ViewSettings";

describe("ViewSettings defaults", () => {
  it("hides Complete and Cancelled by default in both contexts and hides no columns", () => {
    for (const c of ViewSettings.CONTEXTS) {
      const d = ViewSettings.defaults(c);
      expect(d.hiddenStatuses).toEqual(["Complete", "Cancelled"]);
      expect(d.hiddenColumns).toEqual([]);
      expect(ViewSettings.hiddenCount(d)).toBe(2);
    }
  });

  it("offers per-context columns in the agreed default order", () => {
    expect(ViewSettings.defaults("dashboard").columnOrder).toEqual([
      "project", "serviceArea", "owner", "physicianChampion", "status", "nextMilestone", "due", "note", "flags", "inforNumber", "contractsLead",
    ]);
    expect(ViewSettings.defaults("report").columnOrder).toEqual([
      "project", "owner", "physicianChampion", "status", "nextMilestone", "due", "flags", "note", "inforNumber", "contractsLead",
    ]);
    expect(ViewSettings.columnLabel("report", "note")).toBe("Note");
  });

  it("defaults() returns fresh copies", () => {
    const a = ViewSettings.defaults("report");
    a.hiddenStatuses.push("OnHold");
    expect(ViewSettings.defaults("report").hiddenStatuses).toEqual(["Complete", "Cancelled"]);
  });
});

describe("ViewSettings.normalize", () => {
  it("drops unknown and duplicate keys, completes the order, and never hides locked columns", () => {
    const v = ViewSettings.normalize("report", {
      columnOrder: ["due", "bogus", "due", "serviceArea", "project"],
      hiddenColumns: ["project", "status", "note", "serviceArea", "nope"],
      hiddenStatuses: ["Cancelled", "Complete", "Nope", "OnHold"],
    });
    expect(v.columnOrder).toEqual(["due", "project", "owner", "physicianChampion", "status", "nextMilestone", "flags", "note", "inforNumber", "contractsLead"]);
    expect(v.hiddenColumns).toEqual(["note"]);
    expect(v.hiddenStatuses).toEqual(["OnHold", "Complete", "Cancelled"]);
  });

  it("treats a missing hiddenStatuses as the default and an empty one as show all", () => {
    expect(ViewSettings.normalize("dashboard", {}).hiddenStatuses).toEqual(["Complete", "Cancelled"]);
    expect(ViewSettings.normalize("dashboard", { hiddenStatuses: [] }).hiddenStatuses).toEqual([]);
    expect(ViewSettings.normalize("dashboard", null)).toEqual(ViewSettings.defaults("dashboard"));
  });

  it("rejects a wrong shape", () => {
    expect(() => ViewSettings.normalize("dashboard", { hiddenColumns: "note" })).toThrow();
  });
});

describe("ViewSettings edits", () => {
  const d = ViewSettings.defaults("dashboard");

  it("toggles columns and statuses; locked columns stay visible", () => {
    const noOwner = ViewSettings.withColumnHidden("dashboard", d, "owner", true);
    expect(ViewSettings.isColumnVisible(noOwner, "owner")).toBe(false);
    expect(ViewSettings.visibleColumns(noOwner)).not.toContain("owner");
    expect(ViewSettings.withColumnHidden("dashboard", noOwner, "owner", false).hiddenColumns).toEqual([]);
    expect(ViewSettings.withColumnHidden("dashboard", d, "status", true).hiddenColumns).toEqual([]);
    const showDone = ViewSettings.withStatusHidden("dashboard", d, "Complete", false);
    expect(showDone.hiddenStatuses).toEqual(["Cancelled"]);
    expect(ViewSettings.isStatusVisible(showDone, "Complete")).toBe(true);
  });

  it("reorders columns and keeps visibleColumns in that order", () => {
    const moved = ViewSettings.withColumnMoved("dashboard", d, "flags", 1);
    expect(moved.columnOrder.slice(0, 3)).toEqual(["project", "flags", "serviceArea"]);
    const hidden = ViewSettings.withColumnHidden("dashboard", moved, "serviceArea", true);
    expect(ViewSettings.visibleColumns(hidden).slice(0, 3)).toEqual(["project", "flags", "owner"]);
    expect(ViewSettings.withColumnMoved("dashboard", d, "project", 99).columnOrder.at(-1)).toBe("project");
  });

  it("listedRows filters by status only", () => {
    const rows = [{ status: "OnTrack" as const }, { status: "Complete" as const }, { status: "Cancelled" as const }];
    expect(ViewSettings.listedRows(d, rows)).toEqual([{ status: "OnTrack" }]);
  });

});

describe("migration 0002 seed rows", () => {
  /** Columns added after 0002 seeded the rows. normalize() appends them, so seeded rows still equal the defaults. */
  const ADDED_AFTER_0002 = ["inforNumber", "contractsLead"];

  it("match ViewSettings.defaults() for both contexts (after normalize adds later columns)", async () => {
    const { readFileSync } = await import("node:fs");
    const sql = readFileSync("prisma/migrations/0002_view_settings/migration.sql", "utf8");
    for (const c of ViewSettings.CONTEXTS) {
      const d = ViewSettings.defaults(c);
      const seeded = d.columnOrder.filter((k) => !ADDED_AFTER_0002.includes(k));
      expect(ViewSettings.normalize(c, { columnOrder: seeded, hiddenColumns: [], hiddenStatuses: d.hiddenStatuses })).toEqual(d);
      const order = seeded.map((k) => `'${k}'`).join(", ");
      const statuses = d.hiddenStatuses.map((s) => `'${s}'`).join(", ");
      expect(sql).toContain(`('${c}',\n     ARRAY[${order}],\n     ARRAY[]::TEXT[],\n     ARRAY[${statuses}]::"ProjectStatus"[]`);
    }
  });
});
