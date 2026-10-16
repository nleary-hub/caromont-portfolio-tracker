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
