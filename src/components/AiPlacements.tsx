"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Render into document.body so the header backdrop blur never clips it (inline when there is no DOM, e.g. tests). */
function Portal({ children }: { children: ReactNode }) {
  return typeof document === "undefined" ? <>{children}</> : createPortal(children, document.body);
}
import { AiBriefPanel, type AiBriefState } from "@/components/AiBriefPanel";
import { AiToolsPanel } from "@/components/AiToolsPanel";
import { AI_GHOST, Sparkle } from "@/components/AiToolsUi";
import { AiToolsCopy as C } from "@/lib/ai/AiToolsCopy";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/**
 * Where each AI tool shows up on the dashboard (Figma Bro's placement spec, Oct 15). A key that is absent means the
 * feature is off: its control is not rendered. A null note = ready; a string = model off (greyed, aria-disabled,
 * focusable, with that note).
 */
export type AiPlacementNotes = Partial<Record<"meeting_notes" | "bulk_edit" | "quick_capture" | "dictation" | "next_step" | "meeting_brief" | "related_links", string | null>>;

type Named = { id: string; name: string };

/** Paused (model off) props for an AI entry button, with its note id for aria-describedby. */
function paused(note: string | null | undefined, id: string) {
  return note ? { "aria-disabled": true as const, "aria-describedby": id } : {};
}

/** Hover/focus tooltip carrying the model-off note (or a hint), tied to the button with aria-describedby. */
function Tip({ id, text, align = "right" }: { id: string; text: string; align?: "left" | "right" }) {
  return (
    <span id={id} role="tooltip" className={`pointer-events-none absolute top-full ${align === "right" ? "right-0" : "left-0"} z-40 mt-1 hidden w-64 rounded-control border border-line bg-card px-2.5 py-1.5 text-muted type-caption whitespace-normal shadow-lg group-focus-within:block group-hover:block`}>
      {text}
    </span>
  );
}

/** The right-side drawer (480px) AI results open in. Esc closes; focus goes back to what opened it. */
export function AiDrawer({ title, onClose, children, testId }: { title: string; onClose: () => void; children: ReactNode; testId: string }) {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      back?.focus?.();
    };
  }, [onClose]);
  return (
    <Portal>
    <aside
      ref={panel}
      tabIndex={-1}
      role="dialog"
      aria-label={title}
      className="pb-drawer fixed top-[208px] right-6 bottom-6 z-30 flex w-[480px] flex-col gap-4 overflow-y-auto rounded-card border border-line bg-card px-6 py-5 shadow-[-16px_0_40px_rgba(0,0,0,.45)] outline-none"
      data-testid={testId}
    >
      <div className="flex items-start justify-between gap-3">
        <h2 className="type-heading text-base">{title}</h2>
        <button type="button" aria-label="Close" className={`grid size-8 place-items-center rounded-control text-muted hover:text-fg ${FOCUS}`} onClick={onClose}>
          ✕
        </button>
      </div>
      {children}
    </aside>
    </Portal>
  );
}

/** List toolbar "AI" menu: Bulk edit selected (N) and Meeting notes to updates. Hidden when both features are off. */
export function AiToolbarMenu({ notes, selected, visible, defaultOpen = false, defaultTool = null }: { notes: AiPlacementNotes; selected: readonly Named[]; visible: readonly Named[]; defaultOpen?: boolean; defaultTool?: "bulk_edit" | "meeting_notes" | null }) {
  const [open, setOpen] = useState(defaultOpen);
  const [tool, setTool] = useState<"bulk_edit" | "meeting_notes" | null>(defaultTool);
  const hasBulk = "bulk_edit" in notes;
  const hasMeeting = "meeting_notes" in notes;
  if (!hasBulk && !hasMeeting) return null;
  const bulkBlocked = hasBulk && !notes.bulk_edit && selected.length === 0;
  const bulkNote = notes.bulk_edit ?? (bulkBlocked ? C.AI_MENU_SELECT_FIRST : null);
  const scope = selected.length ? selected : visible;
  const names = scope.map((p) => p.name).join("; ");
  const item = `flex w-full items-center gap-2 px-3 py-1.5 text-left type-table text-fg hover:bg-row-selected aria-disabled:cursor-not-allowed aria-disabled:text-muted aria-disabled:hover:bg-transparent ${FOCUS}`;
  return (
    <div className="relative shrink-0" data-testid="ai-toolbar-menu">
      <button type="button" className={AI_GHOST.replace("h-8", "h-7")} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)} onKeyDown={(e) => e.key === "Escape" && setOpen(false)} data-testid="ai-toolbar-button">
        <Sparkle />
        {C.AI_MENU}
        <span aria-hidden className="text-muted">▾</span>
      </button>
      {open && (
        <div role="menu" aria-label={C.AI_MENU} className="absolute top-full right-0 z-30 mt-1 w-72 rounded-card border border-line bg-card py-1 shadow-lg" onKeyDown={(e) => e.key === "Escape" && setOpen(false)}>
          {hasBulk && (
            <div className="flex flex-col">
              <button type="button" role="menuitem" className={item} {...paused(bulkNote, "ai-menu-bulk-note")} onClick={() => !bulkNote && (setTool("bulk_edit"), setOpen(false))} data-testid="ai-menu-bulk">
                <Sparkle />
                {C.AI_MENU_BULK(selected.length)}
              </button>
              {bulkNote && (
                <p id="ai-menu-bulk-note" className="px-3 pb-1.5 pl-[2.125rem] text-muted type-caption">
                  {bulkNote}
                </p>
              )}
            </div>
          )}
          {hasMeeting && (
            <div className="flex flex-col">
              <button type="button" role="menuitem" className={item} {...paused(notes.meeting_notes, "ai-menu-meeting-note")} onClick={() => !notes.meeting_notes && (setTool("meeting_notes"), setOpen(false))} data-testid="ai-menu-meeting">
                <Sparkle />
                {C.AI_MENU_MEETING}
              </button>
              {notes.meeting_notes && (
                <p id="ai-menu-meeting-note" className="px-3 pb-1.5 pl-[2.125rem] text-muted type-caption">
                  {notes.meeting_notes}
                </p>
              )}
            </div>
          )}
          <p className="border-t border-line px-3 pt-1.5 pb-1 text-muted type-caption">{C.AI_MENU_SELECT_HINT}</p>
        </div>
      )}
      {tool && (
        <AiDrawer title={tool === "bulk_edit" ? C.BULK_TITLE : C.MEETING_TITLE} onClose={() => setTool(null)} testId={`ai-drawer-${tool}`}>
          {tool === "bulk_edit" ? (
            <AiToolsPanel feature="bulk_edit" label={C.BULK_LABEL} help={C.BULK_HELP} placeholder={C.BULK_PLACEHOLDER} disabledNote={notes.bulk_edit ?? null} rows={3} context={{ line: C.selectionLine(selected.length, selected.map((p) => p.name).join(", ")), prefix: C.scopePrefix(selected.map((p) => p.name).join("; ")) }} />
          ) : (
            <AiToolsPanel feature="meeting_notes" label={C.MEETING_LABEL} help={C.MEETING_HELP} placeholder={C.MEETING_PLACEHOLDER} disabledNote={notes.meeting_notes ?? null} rows={8} context={{ line: selected.length ? C.selectionLine(selected.length, selected.map((p) => p.name).join(", ")) : C.visibleLine(visible.length), prefix: C.scopePrefix(names) }} />
          )}
        </AiDrawer>
      )}
    </div>
  );
}

/** Header "Quick capture" (shortcut Q): a small popover with the capture box and, when dictation is on, the mic. */
export function AiQuickCapture({ note, dictationNote, defaultOpen = false, recording = false }: { note: string | null; dictationNote?: string | null; defaultOpen?: boolean; /** Preview/tests: start in the Recording state. */ recording?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const off = note !== null;
  const anchor = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState({ top: 64, right: 24 });
  useEffect(() => {
    if (!open || !anchor.current) return;
    const r = anchor.current.getBoundingClientRect();
    setPos({ top: r.bottom + 8, right: Math.max(8, window.innerWidth - r.right) });
  }, [open]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key === "Escape") return setOpen(false);
      if (e.key.toLowerCase() !== "q" || e.metaKey || e.ctrlKey || e.altKey || off) return;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      e.preventDefault();
      setOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [off]);
  return (
    <span ref={anchor} className="group relative shrink-0" data-testid="ai-quick-capture">
      <button type="button" className={AI_GHOST} aria-haspopup="dialog" aria-expanded={open} aria-keyshortcuts="Q" {...(off ? paused(note, "ai-capture-tip") : { "aria-describedby": "ai-capture-tip" })} onClick={() => !off && setOpen((v) => !v)} data-testid="ai-capture-button">
        <Sparkle />
        {C.CAPTURE_BUTTON}
      </button>
      {!open && <Tip id="ai-capture-tip" text={note ?? C.CAPTURE_SHORTCUT} />}
      {open && !off && (
        <Portal>
        <div role="dialog" aria-label={C.CAPTURE_TITLE} className="fixed z-50 w-[380px] rounded-card border border-line bg-card p-3 shadow-lg" style={{ top: pos.top, right: pos.right }} data-testid="ai-capture-popover">
          <AiToolsPanel feature="quick_capture" label={C.CAPTURE_LABEL} help={C.CAPTURE_HELP} placeholder={C.CAPTURE_PLACEHOLDER} disabledNote={null} rows={3} {...(dictationNote !== undefined ? { dictation: { disabledNote: dictationNote, mic: true, ...(recording ? { initialState: "recording" as const } : {}) } } : {})} />
        </div>
        </Portal>
      )}
    </span>
  );
}

/** Dashboard top row, right column: Pre-meeting brief (max 8 lines in the card; Open full opens the drawer). */
export function AiBriefCard({ note, focusOptions, initial, capped = false }: { note: string | null; focusOptions: readonly string[]; initial?: AiBriefState; /** Top row with status cards: the card is held to their height and scrolls inside. */ capped?: boolean }) {
  const [full, setFull] = useState<{ state: AiBriefState; focus: string } | null>(null);
  const card = (
    <section aria-labelledby="ai-brief-card-title" className={`flex flex-col gap-2 rounded-card border border-line bg-card px-4 py-3${capped ? " absolute inset-0 overflow-hidden" : ""}`} data-testid="ai-brief-card">
      <h2 id="ai-brief-card-title" className="flex shrink-0 items-center gap-1.5 type-table-strong text-fg">
        <Sparkle />
        {C.BRIEF_CARD_TITLE}
      </h2>
      <div className={capped ? "-mr-2 min-h-0 flex-1 overflow-y-auto pr-2" : "contents"} data-testid="ai-brief-card-scroll">
        <AiBriefPanel disabledNote={note} focusOptions={focusOptions} compact onOpenFull={(state, focus) => setFull({ state, focus })} {...(initial ? { initial } : {})} />
      </div>
      {full && (
        <AiDrawer title={C.BRIEF_CARD_TITLE} onClose={() => setFull(null)} testId="ai-drawer-brief">
          <AiBriefPanel disabledNote={note} initial={full.state} initialFocus={full.focus} />
        </AiDrawer>
      )}
    </section>
  );
  // Absolutely placed in a relative cell, so the card never adds height to the top row: the status cards set it.
  return capped ? (
    <div className="relative min-w-0" data-testid="ai-brief-cell">
      {card}
    </div>
  ) : (
    card
  );
}

/** Project drawer header "Brief": opens the brief drawer focused on that project. */
export function AiBriefButton({ note, projectName }: { note: string | null; projectName: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="group relative">
      <button type="button" className={AI_GHOST} {...paused(note, "ai-brief-button-note")} onClick={() => !note && setOpen(true)} data-testid="ai-brief-button">
        <Sparkle />
        {C.BRIEF_BUTTON}
      </button>
      {note && <Tip id="ai-brief-button-note" text={note} />}
      {open && (
        <AiDrawer title={C.BRIEF_CARD_TITLE} onClose={() => setOpen(false)} testId="ai-drawer-brief">
          <AiBriefPanel disabledNote={null} initialFocus={projectName} />
        </AiDrawer>
      )}
    </span>
  );
}

/** One shortcut in a row's "..." menu: note null = ready, a string = model off (greyed with that note). */
export type AiRowShortcut = { key: "next_step" | "draft"; label: string; note: string | null };

/**
 * The row's "..." overflow menu with the AI shortcuts (Recommend next milestone, Draft with AI). Each opens the edit drawer
 * focused on that field. No shortcut available (features off) = no menu at all, so the row keeps its size.
 */
export function AiRowMenu({ rowName, items, onPick, defaultOpen = false }: { rowName: string; items: readonly AiRowShortcut[]; onPick: (key: AiRowShortcut["key"]) => void; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);
  if (!items.length) return null;
  const item = `flex w-full items-center gap-2 px-3 py-1.5 text-left font-normal type-table text-fg hover:bg-row-selected aria-disabled:cursor-not-allowed aria-disabled:text-muted aria-disabled:hover:bg-transparent ${FOCUS}`;
  return (
    <span ref={ref} className="relative mt-1 ml-1 inline-block align-top" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === "Escape" && setOpen(false)} data-testid="ai-row-menu">
      <button type="button" className={`inline-flex h-6 items-center rounded-control border border-line bg-card px-2 text-[12px] leading-4 text-muted opacity-0 hover:text-fg focus-visible:opacity-100 aria-expanded:opacity-100 [tr:hover_&]:opacity-100 [tr[aria-selected=true]_&]:opacity-100 ${FOCUS}`} aria-haspopup="menu" aria-expanded={open} aria-label={`${C.ROW_MENU_LABEL}: ${rowName}`} onClick={() => setOpen((v) => !v)} data-testid="ai-row-menu-button">
        <span aria-hidden="true">…</span>
      </button>
      {open && (
        <div role="menu" aria-label={`${C.ROW_MENU_LABEL}: ${rowName}`} className="absolute top-full left-0 z-30 mt-1 w-64 rounded-card border border-line bg-card py-1 shadow-lg">
          {items.map((it) => (
            <div key={it.key} className="flex flex-col">
              <button type="button" role="menuitem" className={item} {...paused(it.note, `ai-row-${it.key}-note`)} onClick={() => !it.note && (setOpen(false), onPick(it.key))} data-testid={`ai-row-${it.key}`}>
                <Sparkle />
                {it.label}
              </button>
              {it.note && (
                <p id={`ai-row-${it.key}-note`} className="px-3 pb-1.5 pl-[2.125rem] font-normal text-muted type-caption">
                  {it.note}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </span>
  );
}
