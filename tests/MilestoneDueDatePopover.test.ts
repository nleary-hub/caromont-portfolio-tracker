import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DueDatePopoverModel as M, type DueDatePopoverEvent } from "@/lib/projects/DueDatePopoverModel";
import { MilestoneEditorModel } from "@/lib/projects/MilestoneEditorModel";

/** Nick's bug: the milestone due date popover closed while typing or changing months. Fictional data only. */
const SAVED = "2026-11-12";
const TODAY = "2026-10-15";
function run(events: DueDatePopoverEvent[], saved = SAVED) {
  let s = M.open(saved, TODAY);
  const saves: string[] = [];
  for (const e of events) {
    const r = M.step(s, e, saved);
    s = r.state;
    if (r.save !== null) saves.push(r.save);
  }
  return { s, saves };
}

describe("milestone due date popover: open and close rules", () => {
  it("opens on the saved date's month, or today's month with no date", () => {
    expect(M.open(SAVED, TODAY)).toEqual({ open: true, draft: SAVED, month: "2026-11" });
    expect(M.open("", TODAY).month).toBe("2026-10");
  });

  it("typing does not close it or save", () => {
    const { s, saves } = run([{ type: "typed", value: "" }, { type: "typed", value: "" }, { type: "typed", value: "2026-12-15" }]);
    expect(s.open).toBe(true);
    expect(s.draft).toBe("2026-12-15");
    expect(s.month).toBe("2026-12");
    expect(saves).toEqual([]);
  });

  it("month navigation does not close it or save", () => {
    const { s, saves } = run([{ type: "nextMonth" }, { type: "nextMonth" }, { type: "prevMonth" }]);
    expect(s).toMatchObject({ open: true, month: "2026-12" });
    expect(saves).toEqual([]);
    expect(M.shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(M.shiftMonth("2026-01", -1)).toBe("2025-12");
  });

  it("Escape closes without saving, even after typing", () => {
    expect(run([{ type: "typed", value: "2026-12-15" }, { type: "escape" }])).toEqual({ s: expect.objectContaining({ open: false }), saves: [] });
  });

  it("a click outside closes it", () => {
    expect(run([{ type: "nextMonth" }, { type: "outside" }])).toEqual({ s: expect.objectContaining({ open: false }), saves: [] });
  });

  it("picking a day closes it and saves that day", () => {
    expect(run([{ type: "nextMonth" }, { type: "pickDay", date: "2026-12-03" }])).toEqual({ s: expect.objectContaining({ open: false }), saves: ["2026-12-03"] });
    expect(run([{ type: "pickDay", date: SAVED }]).saves).toEqual([]);
  });

  it("a typed full date plus Tab saves it; an unfinished date saves nothing", () => {
    expect(run([{ type: "typed", value: "2026-12-15" }, { type: "tabAway" }]).saves).toEqual(["2026-12-15"]);
    expect(run([{ type: "typed", value: "" }, { type: "tabAway" }]).saves).toEqual([]);
    expect(run([{ type: "typed", value: SAVED }, { type: "tabAway" }]).saves).toEqual([]);
  });

  it("emptying the field completely still clears the date, as before", () => {
    expect(run([{ type: "typed", value: "", cleared: true }, { type: "tabAway" }]).saves).toEqual([""]);
    expect(run([{ type: "typed", value: "", cleared: true }, { type: "tabAway" }], "").saves).toEqual([]);
  });

  it("events after close do nothing", () => {
    const closed = M.step(M.open(SAVED, TODAY), { type: "escape" }, SAVED).state;
    expect(M.step(closed, { type: "pickDay", date: "2026-12-03" }, SAVED)).toEqual({ state: closed, save: null });
  });

  it("the calendar grid starts on the right weekday and lists every day as YYYY-MM-DD", () => {
    const g = M.grid("2026-11");
    expect(g.indexOf("2026-11-01")).toBe(0);
    expect(g.filter(Boolean)).toHaveLength(30);
    expect(M.grid("2026-12").indexOf("2026-12-01")).toBe(2);
    expect(M.monthLabel("2026-12")).toBe("December 2026");
  });
});

describe("same save format and write path as before", () => {
  it("typed and picked dates are the same YYYY-MM-DD string the old date input passed", () => {
    const typed = run([{ type: "typed", value: "2026-12-15" }, { type: "tabAway" }]).saves[0];
    const picked = run([{ type: "pickDay", date: "2026-12-15" }]).saves[0];
    expect(typed).toBe("2026-12-15");
    expect(picked).toBe(typed);
    for (const d of M.grid("2027-02").filter((x): x is string => !!x)) expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("the editor saves through the same MilestoneEditorModel.update and commit as before, with no new action", () => {
    const src = readFileSync(path.join(process.cwd(), "src/components/MilestonesEditor.tsx"), "utf8");
    expect(src).toContain("onSave={(d) => void commit(MilestoneEditorModel.update(state, s.key, { dueDate: d }))}");
    const pop = readFileSync(path.join(process.cwd(), "src/components/DueDatePopover.tsx"), "utf8");
    expect(pop).not.toMatch(/@\/app\/actions|fetch\(|History/);
    const state = MilestoneEditorModel.initial([{ id: "s1", name: "Fictional step", dueDate: SAVED, done: false, doneAt: null, checkedBy: null, checkedAt: null, position: 0, sourceTemplateId: null, owner: null }] as never, { nextMilestone: "", dueDate: "" });
    const next = MilestoneEditorModel.update(state, state.steps[0].key, { dueDate: "2026-12-15" });
    expect(MilestoneEditorModel.edit(next, state)?.drafts[0].dueDate).toBe("2026-12-15");
  });
});
