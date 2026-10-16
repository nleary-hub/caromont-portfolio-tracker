import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectFormModel } from "@/lib/projects/ProjectFormModel";

const read = (f: string) => readFileSync(path.resolve(__dirname, "..", f), "utf8");
const dash = read("src/components/ProjectDashboard.tsx");
const table = read("src/components/DashboardTable.tsx");
const closed = read("src/components/ClosedProjectsView.tsx");
const form = read("src/components/ProjectEditForm.tsx");

describe("Project drawer: auto-save replaces Save and the Discard prompt (edit mode)", () => {
  it("auto-save goes through the form's onSubmit (saveProjectForm), debounced, with a visible state", () => {
    expect(form).toMatch(/await latest\.current\.onSubmit\(changes, null\)/);
    expect(form).toMatch(/setTimeout\(\(\) => void runSave\(\), ProjectFormModel\.AUTOSAVE_MS\)/);
    expect(form).toMatch(/data-testid="autosave-status"/);
    expect(dash).toMatch(/onSubmit=\{\(changes, milestones\) => submitForm\(selected\.id, selected\.name, changes, milestones\)\}/);
    expect(ProjectFormModel.AUTOSAVE_MS).toBeGreaterThan(0);
  });

  it("close, Escape, outside click and another row flush first; a failed flush keeps the drawer open", () => {
    expect(dash).toMatch(/void editForm\.flush\(\)\.then\(\(ok\) => \{\s*if \(ok\) action\(\);/);
    expect(dash).toMatch(/document\.addEventListener\("mousedown", onDown\)/);
  });
});

describe("Project drawer: one drawer, single click", () => {
  it("a row click always opens (no toggle-close on the selected row), on the dashboard and the Closed pages", () => {
    expect(table).toMatch(/onMultiToggle\(row\.id\) : onSelect\(row\.id\)\)/);
    expect(table).not.toMatch(/onSelect\(selected \? null : row\.id\)/);
    expect(closed).toMatch(/onSelect=\{\(\) => setSelectedId\(r\.id\)\}/);
  });

  it("there is one drawer panel: one <aside>, read-only fields when there is no form", () => {
    const fn = dash.slice(dash.indexOf("export function ProjectDrawer("), dash.indexOf("function ReadOnlyDetails("));
    expect(fn.match(/<aside/g)).toHaveLength(1);
    expect(dash).not.toMatch(/key="drawer-detail"|key="drawer-form"|onEdit=/);
    expect(fn).toMatch(/\{form \? \(/);
  });

  it("admins open straight into the form, with History, Update notes, Previously and Hide from report", () => {
    expect(dash).toMatch(/const openMode = \(id: string \| null\): DrawerMode => \(id && admin\?\.formValues\[id\] \? "edit" : "view"\)/);
    expect(dash).toMatch(/useProjectTimeline\(row\?\.id \?\? "", row, row \? historyAction : undefined\)/);
    expect(dash).toMatch(/inforPreviously=\{parts\.previously\}/);
    expect(dash).toMatch(/trailing=\{parts\.trailing\}/);
    expect(dash).toMatch(/<UpdateNotesSection/);
    expect(dash).toMatch(/<ProjectHistorySection/);
    expect(dash).toMatch(/adminExtra=\{parts\.admin\}/);
  });

  it("no Discard prompt on a clean form: dirty resets on unmount and after a save", () => {
    expect(form).toMatch(/useEffect\(\(\) => \(\) => onDirtyChange\(false\), \[onDirtyChange\]\)/);
    expect(form).toMatch(/setOriginal\(values\)/);
    // A form opened on stored values has no changes (the hidden % complete never counts).
    const v = ProjectFormModel.empty("2026-10-15");
    expect(ProjectFormModel.isDirty(v, v)).toBe(false);
    expect(ProjectFormModel.isDirty({ ...v, percentComplete: "40" }, v)).toBe(false);
    expect(dash).toMatch(/if \(mode === "new" && dirtyRef\.current\)/);
  });

  it("% complete is not shown in the drawer or the form", () => {
    expect(form).not.toMatch(/pf-percentComplete/);
    expect(dash).not.toMatch(/% complete<\/dt>/);
  });
});
