import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectFormModel } from "@/lib/projects/ProjectFormModel";

const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const form = src("src/components/ProjectEditForm.tsx");

describe("drawer polish: Department and Status use the app's custom dropdown", () => {
  it("has no native select for Department or Status", () => {
    expect(form).not.toMatch(/<select[^>]*id="pf-status"/);
    expect(form).not.toMatch(/<select[^>]*id="pf-serviceArea"/);
    expect(form).toMatch(/PickerSelect[\s\S]{0,40}id="pf-serviceArea"/);
    expect(form).toMatch(/PickerSelect[\s\S]{0,40}id="pf-status"/);
  });
  it("Cancelled from the Status dropdown still raises the confirm dialog", () => {
    expect(form).toMatch(/"Cancelled"[\s\S]{0,200}setConfirmCancel\(true\)/);
  });
  it("PickerSelect is built on the shared field control, popover and list pieces", () => {
    const p = src("src/components/PickerSelect.tsx");
    expect(p).toContain("FieldControlStyle.BOX");
    expect(p).toContain("usePopover");
    expect(p).toContain('role="listbox"');
    expect(p).toContain("vp-list");
  });
});

describe("drawer polish: Start date uses the milestone due date popover", () => {
  it("renders DueDatePopover for startDate and saves through the form's set (no new write path)", () => {
    expect(form).toMatch(/<DueDatePopover[\s\S]{0,80}saved=\{values\.startDate\}/);
    expect(form).toMatch(/onSave=\{\(d\) => \{\s*set\("startDate", d\);/);
    expect(form).not.toMatch(/type="date"[^>]*pf-startDate|id="pf-startDate"[^>]*type="date"/);
  });
  it("the popover effect returns nothing (newer Chrome returns a Promise from scrollIntoView)", () => {
    expect(src("src/components/DueDatePopover.tsx")).not.toMatch(/useEffect\(\(\) => cal\.current/);
  });
});

describe("drawer polish: auto-save error copy", () => {
  it("uses the exact connection copy and keeps the validation copy", () => {
    expect(ProjectFormModel.AUTOSAVE_FAILED).toBe("Couldn't save your change. Check your connection and try again.");
    expect(ProjectFormModel.AUTOSAVE_BLOCKED).toBe("Fix the highlighted fields to save.");
  });
  it("shows the error in the red alert box", () => {
    expect(form).toMatch(/<AiAlert tone="danger" testId="autosave-error">/);
  });
});

describe("Figma review of #76", () => {
  it("the date field is our own text field, never a native date input", () => {
    const pop = src("src/components/DueDatePopover.tsx");
    expect(pop).not.toContain('type="date"');
    expect(pop).toContain('type="text"');
    expect(form).toMatch(/fieldClassName=\{START_DATE_FIELD\}/);
    expect(form).toMatch(/className=\{`\$\{START_DATE_FIELD\} text-left`\}/);
  });
  it("parses typed dates to the same YYYY-MM-DD", async () => {
    const { DueDatePopoverModel: M } = await import("@/lib/projects/DueDatePopoverModel");
    expect(M.parseTyped("12152026")).toBe("2026-12-15");
    expect(M.parseTyped("12/15/2026")).toBe("2026-12-15");
    expect(M.parseTyped("2026-12-15")).toBe("2026-12-15");
    expect(M.parseTyped("Dec 15, 2026")).toBe("2026-12-15");
    expect(M.parseTyped("")).toBe("");
    expect(M.parseTyped("12/15")).toBeNull();
    expect(M.parseTyped("02/30/2026")).toBeNull();
    expect(M.display("2026-10-15")).toBe("Oct 15, 2026");
  });
  it("today is the device's real local date, not a passed-in page date", async () => {
    const { DueDatePopoverModel: M } = await import("@/lib/projects/DueDatePopoverModel");
    expect(M.localToday(new Date(2026, 9, 15, 23, 30))).toBe("2026-10-15");
    expect(M.localToday(new Date(2026, 9, 15, 0, 5))).toBe("2026-10-15");
    const pop = src("src/components/DueDatePopover.tsx");
    expect(pop).toMatch(/d === now \? "text-accent ring-1 ring-inset ring-accent"/);
    expect(pop).not.toMatch(/d === today/);
  });
  it("the project drawer clips instead of hiding overflow, so it can never scroll sideways", () => {
    expect(src("src/components/ProjectDashboard.tsx")).toMatch(/pb-drawer fixed[^"]*overflow-clip/);
  });
});
