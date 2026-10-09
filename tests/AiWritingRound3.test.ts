import { readFileSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AiAlert, AiUndoLine } from "@/components/AiNoteAssistant";
import { AiCopy } from "@/lib/ai/AiCopy";

const SRC = (p: string) => readFileSync(path.resolve(__dirname, "..", p), "utf8");
describe("round 3 copy", () => {
  it("has the Writing Bot strings", () => {
    expect(AiCopy.PANEL_NOTE).toBe("Nothing changes until you save the project.");
    expect(AiCopy.phiBlocked(["mrn"])).toBe("This might be patient information (a medical record number). Remove it and try again. Nothing was sent.");
    expect(AiCopy.phiBlocked(["dob", "patient_name"])).toBe("This might be patient information (a date that could be a date of birth and a name that could be a patient's). Remove it and try again. Nothing was sent.");
    expect(AiCopy.PAGE_INTRO).toBe("Only admins can see this page. These settings turn on the writing assistant for everyone who can edit a project. Every change is recorded below.");
    expect(AiCopy.SWITCH_HELP_OFF).toBe("Off. No AI buttons show when anyone writes an update.");
    expect(AiCopy.SWITCH_HELP_ON).toBe("On. Editors see Draft from bullets and Fit for report when they write an update.");
    expect(AiCopy.REFERENCE_LABEL).toBe("Suggestion, for reference");
    for (const v of Object.values(AiCopy)) if (typeof v === "string") expect(v).not.toContain("\u2014");
  });

  it("the New project form's submit button says Save, so it keeps the save wording", () => {
    const form = SRC("src/components/ProjectEditForm.tsx");
    expect(form).toContain('{saving ? "Saving…" : "Save"}');
    expect(form).not.toMatch(/Create project/);
  });
});

describe("round 3 Figma fixes", () => {
  const a = SRC("src/components/AiNoteAssistant.tsx");
  const form = SRC("src/components/ProjectEditForm.tsx");

  it('clears "Your original text is back." on typing in the note or running the assistant', () => {
    expect(form).toContain('if (aiUndo?.state === "undone") setAiUndo(null);');
    expect(form).toContain('onRun={() => setAiUndo((u) => (u?.state === "undone" ? null : u))}');
    expect(a).toMatch(/if \(busy\) return;\s+onRun\?\.\(\);/);
  });

  it("edit mode shows the marked suggestion read-only, labelled, with the legend, above the edit box", () => {
    const ref = a.indexOf('data-testid="ai-reference"');
    const edit = a.indexOf('data-testid="ai-suggestion-edit"');
    expect(ref).toBeGreaterThan(0);
    expect(ref).toBeLessThan(edit);
    const block = a.slice(ref, a.indexOf("</div>", ref));
    expect(block).toContain("{C.REFERENCE_LABEL}");
    expect(block.indexOf("{C.REFERENCE_LABEL}")).toBeLessThan(block.indexOf("<Legend"));
    expect(block).toContain("<MarkedText segments={segments} />");
  });

  it("the edit box grows with JS (AutoGrowTextarea), not field-sizing", () => {
    expect(a).toContain("<AutoGrowTextarea");
    expect(a).not.toContain("field-sizing-content");
    const grow = SRC("src/components/AutoGrowTextarea.tsx");
    expect(grow).toContain("el.scrollHeight");
  });

  it("the Undo link is at least 24px tall", () => {
    const html = renderToStaticMarkup(createElement(AiUndoLine, { state: "applied", onUndo: () => {} }));
    expect(html).toMatch(/data-testid="ai-undo"/);
    expect(html).toMatch(/class="[^"]*\bmin-h-6\b[^"]*"[^>]*data-testid="ai-undo"/);
  });

  it("provider error, timeout and rate limit use the red alert box with its icon", () => {
    expect(a).toMatch(/<AiAlert tone="danger" testId="ai-error">/);
    const html = renderToStaticMarkup(createElement(AiAlert, { tone: "danger", testId: "ai-error" }, AiCopy.TIMEOUT));
    expect(html).toContain("<svg");
    expect(html).toContain("bg-(--status-off-track-dark-bg)");
    expect(html).toContain('role="alert"');
  });
});
