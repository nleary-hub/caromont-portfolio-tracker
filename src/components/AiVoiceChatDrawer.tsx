"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AiVoiceChatPanel } from "@/components/AiVoiceChatPanel";
import { TOOL_PRIMARY } from "@/components/AiToolsUi";
import { AiToolsCopy as C } from "@/lib/ai/AiToolsCopy";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

function MicIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <rect x="5.5" y="1.75" width="5" height="8" rx="2.5" />
      <path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2" />
    </svg>
  );
}

/**
 * Dashboard header "Voice chat" (the only filled AI button). Opens the #62 voice panel as the right drawer with the
 * dashboard visible behind it. Model off: greyed, aria-disabled, still focusable, with the note as its description and
 * tooltip. Feature off: the parent doesn't render this at all.
 */
export function AiVoiceChatDrawer({ disabledNote, defaultOpen = false }: { disabledNote: string | null; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const button = useRef<HTMLButtonElement>(null);
  const off = disabledNote !== null;
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  return (
    <>
      <span className="group relative shrink-0">
        <button
          ref={button}
          type="button"
          className={`${TOOL_PRIMARY} inline-flex items-center gap-1.5`}
          aria-haspopup="dialog"
          aria-expanded={open}
          {...(off ? { "aria-disabled": true as const, "aria-describedby": "ai-voice-header-off" } : {})}
          onClick={() => !off && setOpen((v) => !v)}
          data-testid="ai-voice-header"
        >
          <MicIcon />
          {C.VOICE_CHAT_TITLE}
        </button>
        {off && (
          <span id="ai-voice-header-off" role="tooltip" className="pointer-events-none absolute top-full right-0 z-30 mt-1 hidden w-64 rounded-control border border-line bg-card px-2.5 py-1.5 text-muted type-caption shadow-lg group-focus-within:block group-hover:block" data-testid="ai-voice-header-off">
            {disabledNote}
          </span>
        )}
      </span>
      {open && !off && typeof document !== "undefined" && createPortal(
        // Portal: the header's backdrop blur would otherwise make it the containing block of this fixed drawer.
        <aside
          role="dialog"
          aria-label={C.VOICE_CHAT_TITLE}
          className="pb-drawer fixed top-[208px] right-6 bottom-6 z-30 flex w-[480px] flex-col gap-4 overflow-y-auto rounded-card border border-line bg-card px-6 py-5 shadow-[-16px_0_40px_rgba(0,0,0,.45)]"
          data-testid="ai-voice-drawer"
        >
          <div className="flex items-start justify-between gap-3">
            <h2 className="type-heading text-base">{C.VOICE_CHAT_TITLE}</h2>
            <button type="button" aria-label="Close" className={`grid size-8 place-items-center rounded-control text-muted hover:text-fg ${FOCUS}`} onClick={close}>
              ✕
            </button>
          </div>
          <AiVoiceChatPanel disabledNote={null} />
        </aside>,
        document.body,
      )}
    </>
  );
}
