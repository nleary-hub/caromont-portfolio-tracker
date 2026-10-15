"use client";

import { AiOffNote, pausedProps, TOOL_PRIMARY } from "@/components/AiToolsUi";
import Link from "next/link";
import { useState, useTransition } from "react";
import { makeAiMeetingBrief } from "@/app/actions/aiTools";
import { AiAlert } from "@/components/AiNoteAssistant";
import { AiToolsCopy as C } from "@/lib/ai/AiToolsCopy";
import type { AiBrief, AiBriefItem } from "@/lib/ai/AiToolsModel";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const INPUT = `h-8 w-full min-w-0 rounded-control border border-line bg-input px-2.5 text-fg type-table focus:border-accent disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`;

export type AiBriefState = { kind: "idle" } | { kind: "error"; message: string } | { kind: "brief"; brief: AiBrief };

/** Step 8: a read-only brief with links to the projects. Not saved, emailed or added to any report. */
export function AiBriefPanel({ disabledNote, initial, initialFocus = "", focusOptions, compact = false, onOpenFull }: { disabledNote: string | null; initial?: AiBriefState; initialFocus?: string; focusOptions?: readonly string[]; compact?: boolean; onOpenFull?: (state: AiBriefState, focus: string) => void }) {
  const [focus, setFocus] = useState(initialFocus);
  const [state, setState] = useState<AiBriefState>(initial ?? { kind: "idle" });
  const [pending, start] = useTransition();
  const off = disabledNote !== null;
  return (
    <div className="flex flex-col gap-2" data-testid="ai-tool-meeting_brief">
      <label htmlFor="ai-brief-focus" className="text-muted type-caption">
        {C.BRIEF_LABEL}
      </label>
      <div className="flex items-center gap-3">
        <input id="ai-brief-focus" className={`${INPUT} max-w-[24rem]`} value={focus} onChange={(e) => setFocus(e.target.value)} placeholder={C.BRIEF_PLACEHOLDER} disabled={off} aria-describedby="ai-brief-help" list={focusOptions ? "ai-brief-focus-options" : undefined} />
        {focusOptions && (
          <datalist id="ai-brief-focus-options">
            {focusOptions.map((o) => (
              <option key={o} value={o} />
            ))}
          </datalist>
        )}
        <button
          type="button"
          className={TOOL_PRIMARY}
          disabled={!off && pending}
          {...pausedProps(disabledNote, "ai-brief-off")}
          data-testid="ai-tool-meeting_brief-propose"
          onClick={() =>
            !off &&
            start(async () => {
              const r = await makeAiMeetingBrief(focus);
              setState(r.ok ? { kind: "brief", brief: r.brief } : { kind: "error", message: r.message });
            })
          }
        >
          {pending ? C.PROPOSING : C.BRIEF_PROPOSE}
        </button>
      </div>
      <p id="ai-brief-help" className="text-muted type-caption">
        {C.BRIEF_HELP}
      </p>
      <AiOffNote id="ai-brief-off" note={disabledNote} testId="ai-tool-meeting_brief-off" />
      {state.kind === "error" && <AiAlert tone="danger" testId="ai-tool-brief-error">{state.message}</AiAlert>}
      {state.kind === "brief" && (
        <article aria-label={C.BRIEF_TITLE} className={`flex flex-col gap-3 rounded-card border border-line bg-input/60 p-3 ${compact ? "max-h-[11.5rem] overflow-hidden" : ""}`} data-testid="ai-tool-brief">
          <div className="flex items-center gap-2">
            <span className="rounded-pill bg-(--status-not-started-dark-bg) px-2 py-px text-(--status-not-started-dark-fg) type-label">{C.AI_LABEL}</span>
            <span className="text-muted type-caption">{C.BRIEF_NOTE}</span>
          </div>
          <BriefList title={C.BRIEF_MOVED} items={state.brief.moved} />
          <BriefList title={C.BRIEF_STUCK} items={state.brief.stuck} />
          <BriefList title={C.BRIEF_ASK} items={state.brief.ask} />
        </article>
      )}
      {compact && onOpenFull && state.kind === "brief" && (
        <button type="button" className="self-start text-accent type-table-strong hover:underline" onClick={() => onOpenFull(state, focus)} data-testid="ai-brief-open-full">
          {C.BRIEF_OPEN_FULL}
        </button>
      )}
    </div>
  );
}

function BriefList({ title, items }: { title: string; items: AiBriefItem[] }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="type-table-strong text-fg">{title}</h3>
      {items.length === 0 ? (
        <p className="text-muted type-table">{C.BRIEF_EMPTY}</p>
      ) : (
        <ul className="flex list-disc flex-col gap-1 pl-5 type-table">
          {items.map((i, n) => (
            <li key={n}>
              <Link href={`/?project=${i.projectId}`} className="type-table-strong text-accent hover:underline">
                {i.projectName}
              </Link>
              <span className="text-fg">: {i.text}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
