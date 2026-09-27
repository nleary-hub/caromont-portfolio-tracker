import { describe, expect, it } from "vitest";
import { SignInBackdrop } from "@/lib/auth/SignInBackdrop";

// The /signin portfolio wall is shown before sign-in, so it must be made-up, stable sample data.
describe("SignInBackdrop", () => {
  it("renders the same rows every time (server and browser markup must match)", () => {
    expect(SignInBackdrop.columns()).toEqual(SignInBackdrop.columns());
  });

  it("fills every column, shows every status and gives each row a unique id", () => {
    const columns = SignInBackdrop.columns();
    expect(columns).toHaveLength(SignInBackdrop.COLUMNS);
    expect(SignInBackdrop.COLUMN_SPEEDS_S).toHaveLength(SignInBackdrop.COLUMNS);
    const rows = columns.flat();
    expect(rows).toHaveLength(SignInBackdrop.COLUMNS * SignInBackdrop.ROWS_PER_COLUMN);
    expect(new Set(rows.map((r) => r.status))).toEqual(new Set(SignInBackdrop.STATUSES));
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    for (const r of rows) {
      expect(r.progress).toBeGreaterThan(0);
      expect(r.progress).toBeLessThanOrEqual(1);
    }
  });

  it("reads 'Every project. One view.' with three counters", () => {
    expect(SignInBackdrop.STATEMENT.join(" ")).toBe("Every project. One view.");
    expect(SignInBackdrop.METRICS.map((m) => m.label)).toEqual(["Active", "On track", "Reports sent"]);
  });
});
