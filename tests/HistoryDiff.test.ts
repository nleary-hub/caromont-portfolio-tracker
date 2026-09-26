import { describe, expect, it } from "vitest";
import { HistoryDiff } from "@/lib/history/HistoryDiff";

describe("HistoryDiff", () => {
  it("reports only changed tracked fields with serialized values", () => {
    const before = { name: "A", status: "OnTrack", dueDate: new Date("2026-10-01T00:00:00Z"), percentComplete: 10, note: null };
    const after = { name: "A", status: "AtRisk", dueDate: new Date("2026-10-08T00:00:00Z"), percentComplete: 10, note: "x", id: "ignored" };
    expect(HistoryDiff.diff(before, after)).toEqual([
      { field: "status", oldValue: "OnTrack", newValue: "AtRisk" },
      { field: "dueDate", oldValue: "2026-10-01", newValue: "2026-10-08" },
      { field: "note", oldValue: null, newValue: "x" },
    ]);
  });

  it("serializes timestamps as full ISO and booleans/numbers as strings", () => {
    const at = new Date("2026-10-07T10:00:00Z");
    expect(HistoryDiff.serialize("archivedAt", at)).toBe("2026-10-07T10:00:00.000Z");
    expect(HistoryDiff.serialize("includeInReport", false)).toBe("false");
    expect(HistoryDiff.serialize("percentComplete", 0)).toBe("0");
  });
});
