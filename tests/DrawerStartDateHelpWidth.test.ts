import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/** Drawer edit form: the Start date help text spans both columns of the dates row (full drawer width). */
describe("drawer Start date help width", () => {
  it("the help line spans the full dates row", () => {
    const src = readFileSync(path.resolve(__dirname, "../src/components/ProjectEditForm.tsx"), "utf8");
    const line = src.split("\n").find((l) => l.includes('data-testid="start-date-help"'))!;
    expect(line).toContain("col-span-2");
    expect(line).not.toContain("col-start-1");
  });
});
