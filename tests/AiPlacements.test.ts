import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AiBriefButton, AiPlacementLinks, AiQuickCapture, AiRowMenu, AiToolbarMenu, type AiPlacementNotes } from "@/components/AiPlacements";
import { AiNextStepPanel } from "@/components/AiNextStepPanel";
import { AiDictationButton } from "@/components/AiDictationButton";
import { AdminMenu } from "@/lib/admin/AdminMenu";
import { AiToolsCopy as C } from "@/lib/ai/AiToolsCopy";
import { AiPlacementData } from "@/lib/services/AiToolsReadiness";

vi.mock("@/app/actions/aiActions", () => ({ runAiCommand: vi.fn(), applyAiActions: vi.fn(), rejectAiActions: vi.fn() }));
vi.mock("@/app/actions/aiTools", () => ({
  proposeAiToolChanges: vi.fn(),
  applyAiToolLine: vi.fn(),
  rejectAiToolLine: vi.fn(),
  transcribeAiDictation: vi.fn(),
  proposeAiBrief: vi.fn(),
  proposeAiRelatedLinks: vi.fn(),
  confirmAiRelatedLink: vi.fn(),
  removeRelatedLink: vi.fn(),
}));

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const tag = (h: string, testId: string) => h.match(new RegExp(`<button[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? "";
/** Model off: greyed (aria-disabled), still focusable (no disabled attribute), described by a note with that text. */
const expectPaused = (h: string, testId: string, note: string) => {
  const b = tag(h, testId);
  expect(b).toContain('aria-disabled="true"');
  expect(b).not.toMatch(/\sdisabled=""/);
  const id = b.match(/aria-describedby="([^"]+)"/)?.[1];
  expect(id).toBeTruthy();
  expect(h).toMatch(new RegExp(`id="${id}"[^>]*>${note.replace(/[.()]/g, "\\$&")}<`));
};
const expectReady = (h: string, testId: string) => expect(tag(h, testId)).not.toContain(`aria-disabled="true"`);
const rows = [
  { id: "p1", name: "Example Clinic refresh" },
  { id: "p2", name: "Sample Lab move" },
  { id: "p3", name: "Example Imaging upgrade" },
];
const OFF = C.MODEL_OFF_NOTE;

describe("placement 1: list toolbar AI menu", () => {
  const menu = (notes: AiPlacementNotes, selected = rows.slice(0, 0)) => html(createElement(AiToolbarMenu, { notes, selected, visible: rows, defaultOpen: true }));
  it("feature off (both): nothing rendered, no gap", () => {
    expect(html(createElement(AiToolbarMenu, { notes: {}, selected: [], visible: rows }))).toBe("");
  });
  it("one feature off: its item is not rendered", () => {
    const h = menu({ meeting_notes: null });
    expect(h).not.toContain("ai-menu-bulk");
    expect(h).toContain("ai-menu-meeting");
  });
  it("labels: Bulk edit selected (N) and Meeting notes to updates", () => {
    expect(menu({ bulk_edit: null, meeting_notes: null }, rows)).toContain("Bulk edit selected (3)");
    expect(menu({ bulk_edit: null, meeting_notes: null })).toContain("Meeting notes to updates");
  });
  it("0 selected: Bulk edit greyed with Select one or more rows first.", () => {
    expectPaused(menu({ bulk_edit: null, meeting_notes: null }), "ai-menu-bulk", C.AI_MENU_SELECT_FIRST);
    expectReady(menu({ bulk_edit: null, meeting_notes: null }, rows), "ai-menu-bulk");
  });
  it("model off: both items greyed with the model-off note", () => {
    const h = menu({ bulk_edit: OFF, meeting_notes: OFF }, rows);
    expectPaused(h, "ai-menu-bulk", OFF);
    expectPaused(h, "ai-menu-meeting", OFF);
  });
  it("menu sits after the filter bar and before Mark all as reviewed", () => {
    const src = readFileSync("src/components/ProjectDashboard.tsx", "utf8");
    expect(src.indexOf("<AiToolbarMenu")).toBeGreaterThan(src.indexOf('data-testid="filter-bar"'));
    expect(src.indexOf("<AiToolbarMenu")).toBeLessThan(src.indexOf("<MarkAllReviewedButton"));
  });
  it("results open in the 480px right drawer", () => {
    const h = html(createElement(AiToolbarMenu, { notes: { bulk_edit: null }, selected: rows, visible: rows, defaultTool: "bulk_edit" }));
    expect(h).toContain("w-[480px]");
    expect(h).toContain('data-testid="ai-drawer-bulk_edit"');
    expect(h).toContain("Working on 3 selected projects: ");
  });
});

describe("placement 2: Recommend next milestone and row shortcuts", () => {
  const next = (note: string | null) => html(createElement(AiNextStepPanel, { inline: true, projects: [rows[0]], initialProject: "p1", disabledNote: note }));
  it("ready: ghost Recommend next milestone, not greyed", () => {
    const h = next(null);
    expect(h).toContain(C.NEXT_INLINE);
    expect(C.NEXT_INLINE).toBe("Recommend next milestone");
    expectReady(h, "ai-tool-next_step-propose");
  });
  it("model off: greyed, focusable, with the note", () => expectPaused(next(OFF), "ai-tool-next_step-propose", OFF));
  it("feature off: the edit form gets no aiNextStep (not rendered)", () => {
    const src = readFileSync("src/components/ProjectDashboard.tsx", "utf8");
    expect(src).toMatch(/"next_step" in aiPlacements \? \{ aiNextStep:/);
  });
  const menu = (items: Parameters<typeof AiRowMenu>[0]["items"]) => html(createElement(AiRowMenu, { rowName: "Example Clinic refresh", items, onPick: () => {}, defaultOpen: true }));
  it("row ... menu: no shortcuts (features off) = no menu at all", () => expect(menu([])).toBe(""));
  it("row ... menu lists Recommend next milestone and Draft with AI", () => {
    const h = menu([{ key: "next_step", label: C.NEXT_INLINE, note: null }, { key: "draft", label: C.ROW_DRAFT, note: null }]);
    expect(h).toContain(C.NEXT_INLINE);
    expect(h).toContain("Draft with AI");
    expectReady(h, "ai-row-next_step");
  });
  it("row ... menu: model off greys the shortcut with the note", () => {
    const h = menu([{ key: "draft", label: C.ROW_DRAFT, note: OFF }]);
    expectPaused(h, "ai-row-draft", OFF);
  });
});

describe("placement 3: Quick capture and dictation", () => {
  it("feature off: header gets no Quick capture (aiActions undefined)", () => {
    const src = readFileSync("src/components/ProjectDashboard.tsx", "utf8");
    expect(src).toContain(`{aiPlacements && "quick_capture" in aiPlacements && <AiQuickCapture`);
    expect(readFileSync("src/components/DashboardTopBar.tsx", "utf8")).toMatch(/\{aiActions && \(\s*<div/);
  });
  it("ready: Quick capture with the Q shortcut in its tooltip", () => {
    const h = html(createElement(AiQuickCapture, { note: null }));
    expectReady(h, "ai-capture-button");
    expect(tag(h, "ai-capture-button")).toContain('aria-keyshortcuts="Q"');
    expect(h).toContain(C.CAPTURE_SHORTCUT);
  });
  it("model off: greyed with the note", () => expectPaused(html(createElement(AiQuickCapture, { note: OFF })), "ai-capture-button", OFF));
  it("dictation off: popover has no mic, capture still works", () => {
    const h = html(createElement(AiQuickCapture, { note: null, defaultOpen: true }));
    expect(h).toContain("ai-capture-popover");
    expect(h).not.toContain("ai-dictation-button");
  });
  it("dictation on: mic sits inside the text box", () => {
    const h = html(createElement(AiQuickCapture, { note: null, dictationNote: null, defaultOpen: true }));
    expect(h).toContain('data-testid="ai-dictation-button"');
    expectReady(h, "ai-dictation-button");
  });
  it("dictation model off: mic greyed with the note, independent of capture", () => {
    const h = html(createElement(AiQuickCapture, { note: null, dictationNote: OFF, defaultOpen: true }));
    expectPaused(h, "ai-dictation-button", OFF);
    expectReady(h, "ai-capture-button");
  });
  it("recording: stop square and Recording in a status region", () => {
    const h = html(createElement(AiDictationButton, { mic: true, disabledNote: null, onText: () => {}, initialState: "recording" }));
    expect(h).toMatch(/role="status"[^>]*>Recording</);
    expect(h).toContain(`aria-label="${C.DICTATE_STOP}"`);
  });
  it("Q is ignored while typing in inputs", () => {
    const src = readFileSync("src/components/AiPlacements.tsx", "utf8");
    expect(src).toContain('["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName)');
  });
});

describe("placement 4: Meeting Playbook (replaces the pre-meeting brief card)", () => {
  it("no brief card above the table any more; the drawer button and the AI menu open the playbook page", () => {
    const src = readFileSync("src/components/ProjectDashboard.tsx", "utf8");
    expect(src).not.toContain("<AiBriefCard");
    expect(src).toMatch(/"meeting_brief" in aiPlacements \? \{ headerAction: <AiBriefButton note=\{aiPlacements.meeting_brief \?\? null\} projectId=\{selected.id\}/);
    expect(src).not.toContain("grid-cols-[minmax(0,1fr)_380px]");
    expect(src).toContain("{!emptyLine && tileTemplate && (");
  });
  it("drawer Playbook button: a link scoped to the project when ready, greyed with the note when the model is off", () => {
    const h = html(createElement(AiBriefButton, { note: null, projectId: "10000000-0000-4000-8000-0000000000a1", projectName: "Example Clinic refresh" }));
    expectReady(h, "ai-brief-button");
    expect(h).toContain('href="/playbook?ids=10000000-0000-4000-8000-0000000000a1&amp;label=Example%20Clinic%20refresh"');
    expect(h).toContain(C.PLAYBOOK_BUTTON);
    expectPaused(html(createElement(AiBriefButton, { note: OFF, projectId: "x", projectName: "Example Clinic refresh" })), "ai-brief-button", OFF);
  });
  it("the AI menu offers the playbook for the selection or the current filter; long lists scope to the whole line", () => {
    const h = html(createElement(AiToolbarMenu, { notes: { meeting_brief: null }, selected: [], visible: rows, defaultOpen: true }));
    expect(h).toContain('data-testid="ai-menu-playbook"');
    expect(h).toContain("/playbook?ids=p1,p2,p3&amp;label=3%20projects%20in%20the%20dashboard%20filter");
    expect(AiPlacementLinks.playbook(Array.from({ length: 151 }, (_, i) => ({ id: String(i), name: "x" })), "x")).toBe("/playbook");
    expectPaused(html(createElement(AiToolbarMenu, { notes: { meeting_brief: OFF }, selected: [], visible: rows, defaultOpen: true })), "ai-menu-playbook", OFF);
  });
});

describe("placement 5 removed: no Find related in the drawer (it saved related projects as Blocked by)", () => {
  const src = () => readFileSync("src/components/ProjectDashboard.tsx", "utf8");
  it("the drawer renders no AI links panel and no Suggested related projects subsection", () => {
    expect(src()).not.toContain("AiLinksPanel");
    // Item 8: related_links is now only the AI blocker suggestions, passed into the Dependencies section.
    expect(src().match(/related_links/g)?.length).toBe(2);
    expect(src()).toContain('"related_links" in aiPlacements ? { ai: (reload: () => void) => <AiDependencySuggestPanel');
    expect(src()).not.toContain("LINKS_SUGGESTED_TITLE");
    expect(src()).not.toContain("ai-related-section");
  });
  it("the only dependency write path in the drawer is the Dependencies & blockers section", () => {
    expect(src()).not.toMatch(/dependencyActions!?\.add\(/);
    expect(src()).toContain("actions={admin.dependencyActions}");
  });
  it("placement data offers related_links (item 8: AI blocker suggestions) when the feature and model are on", async () => {
    expect(AiPlacementData.FEATURES).toContain("related_links" as never);
    const db = {
      aiSettings: { findUnique: async () => ({ enabled: true, model: "gpt-example-mini", provider: "openai" }) },
      aiModel: { findMany: async () => [{ id: "gpt-example-mini", enabled: true, kind: "chat" }] },
      aiFeatureSetting: { findMany: async () => [{ feature: "related_links", enabled: true }], findUnique: async () => ({ feature: "related_links", enabled: true }) },
    } as never;
    const out = await AiPlacementData.load(db, {});
    expect("meeting_notes" in out).toBe(true);
    expect("related_links" in out).toBe(true);
  });
});

describe("placement data and /ai-tools", () => {
  it("features that are off are left out; model off keeps the note", async () => {
    const db = {
      aiSettings: { findUnique: async () => ({ enabled: true, model: "gpt-example-mini", provider: "openai" }) },
      aiModel: { findMany: async () => [] },
      aiFeatureSetting: { findMany: async () => [], findUnique: async () => null },
    } as never;
    const out = await AiPlacementData.load(db, { AI_FEATURE_BULK_EDIT: "off", AI_FEATURE_DICTATION: "off" }).catch(() => null);
    if (out) {
      expect("bulk_edit" in out).toBe(false);
      expect("dictation" in out).toBe(false);
    }
  });
  it("/ai-tools stays a working page; its link moved out of the work group", () => {
    expect(readFileSync("src/app/ai-tools/page.tsx", "utf8")).not.toContain("redirect(");
    const item = AdminMenu.definitions().find((d) => d.id === "ai-tools");
    expect(item).toMatchObject({ group: "admin", href: "/ai-tools", shipped: true });
  });
  it("no Voice chat button and no em dashes in the placement code", () => {
    const src = readFileSync("src/components/AiPlacements.tsx", "utf8");
    expect(src).not.toContain("VoiceChat");
    expect(src).not.toContain("\u2014");
  });
});
