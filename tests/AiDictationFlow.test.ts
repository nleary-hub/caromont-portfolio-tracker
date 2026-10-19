import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AiMeetingNotesPanel, meetingNotesSubmits } from "@/components/AiMeetingNotesPanel";
import { AiToolsCopy } from "@/lib/ai/AiToolsCopy";

vi.mock("@/app/actions/aiActions", () => ({ processAiMeetingNotes: vi.fn(), applyAiActions: vi.fn(), rejectAiActions: vi.fn() }));
vi.mock("@/app/actions/aiTools", () => ({ transcribeAiDictation: vi.fn(), createAiDraftProject: vi.fn() }));

// Item 11: dictated text flows straight into the command bar or meeting notes, no extra clicks.
const src = (f: string) => readFileSync(f, "utf8");

describe("dictation reaches the command bar and meeting notes with no extra click", () => {
  it("command bar: the transcript is sent as the message right away", () => {
    expect(src("src/components/AiCommandBar.tsx")).toContain("<AiDictationButton mic disabledNote={dictationNote} onText={send}");
  });

  it("meeting notes: the transcript lands in the box (appended), caret to the end, focus kept in the box", () => {
    const p = src("src/components/AiMeetingNotesPanel.tsx");
    expect(p).toContain("onText={add}");
    expect(p).toContain("el.setSelectionRange(el.value.length, el.value.length)");
  });

  it("every Meeting notes and command bar placement passes dictation when it is on", () => {
    const placements = src("src/components/AiPlacements.tsx");
    expect(placements).toMatch(/<AiMeetingNotesPanel[^\n]*dictation: \{ disabledNote/);
    expect(placements).toMatch(/<AiCommandBar[^\n]*dictationNote/);
    const tools = src("src/app/ai-tools/page.tsx");
    expect(tools).toMatch(/<AiMeetingNotesPanel[^\n]*dictation: \{ disabledNote/);
    expect(tools).toMatch(/<AiCommandBar[^\n]*dictationNote/);
    expect(src("src/components/AiPlaybook.tsx")).toMatch(/<AiMeetingNotesPanel[^\n]*dictation: \{ disabledNote/);
  });

  it("Ctrl+Enter or Cmd+Enter suggests from the box; plain Enter, an empty box, a running call or a paused model do not", () => {
    const k = (over: Partial<{ key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => ({ key: "Enter", ctrlKey: true, metaKey: false, ...over });
    const s = { off: false, pending: false, text: "Drywall done on EP Lab 2." };
    expect(meetingNotesSubmits(k(), s)).toBe(true);
    expect(meetingNotesSubmits(k({ ctrlKey: false, metaKey: true }), s)).toBe(true);
    expect(meetingNotesSubmits(k({ ctrlKey: false }), s)).toBe(false);
    expect(meetingNotesSubmits(k({ altKey: true }), s)).toBe(false);
    expect(meetingNotesSubmits(k({ key: "a" }), s)).toBe(false);
    expect(meetingNotesSubmits(k(), { ...s, text: "  " })).toBe(false);
    expect(meetingNotesSubmits(k(), { ...s, pending: true })).toBe(false);
    expect(meetingNotesSubmits(k(), { ...s, off: true })).toBe(false);
  });

  it("the box says so: shortcut line (with the dictation note when the mic is there); nothing when the model is off", () => {
    const withMic = renderToStaticMarkup(createElement(AiMeetingNotesPanel, { disabledNote: null, dictation: { disabledNote: null } }));
    expect(withMic).toContain(AiToolsCopy.MEETING_KEYS_DICTATION);
    expect(withMic).toContain('aria-keyshortcuts="Control+Enter Meta+Enter"');
    expect(withMic).toContain('data-testid="ai-dictation"');
    expect(renderToStaticMarkup(createElement(AiMeetingNotesPanel, { disabledNote: null }))).toContain(AiToolsCopy.MEETING_KEYS);
    expect(renderToStaticMarkup(createElement(AiMeetingNotesPanel, { disabledNote: "Model off" }))).not.toContain('data-testid="ai-tool-meeting_notes-keys"');
    for (const c of [AiToolsCopy.MEETING_KEYS, AiToolsCopy.MEETING_KEYS_DICTATION]) expect(c).not.toContain("\u2014");
  });
});
