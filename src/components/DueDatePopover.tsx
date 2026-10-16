"use client";

import { useEffect, useRef, useState } from "react";
import { DueDatePopoverModel, type DueDatePopoverEvent } from "@/lib/projects/DueDatePopoverModel";

/**
 * The milestone due date editor: the date field (typing works as before) with a small calendar under it. Stays open
 * while typing and while moving between months; closes on a picked day, Escape, Tab away or a click outside
 * (DueDatePopoverModel). The calendar buttons are mouse targets outside the Tab order, so Tab from the field
 * leaves the popover and saves a typed date; keyboard users type the date. onSave gets the same YYYY-MM-DD string the date input always produced; the caller saves it
 * through the existing milestone update, so there is no new write path.
 */
export function DueDatePopover({ saved, today, label, onSave, onClose }: { saved: string; today: string; label: string; onSave: (date: string) => void; onClose: () => void }) {
  const [s, setS] = useState(() => DueDatePopoverModel.open(saved, today));
  const root = useRef<HTMLDivElement>(null);
  const done = useRef(false);
  const cal = useRef<HTMLDivElement>(null);
  // On open, scroll the drawer just enough that the whole calendar shows above the drawer's footer.
  // Braces matter: newer Chrome returns a Promise from scrollIntoView, and an effect must return nothing or a cleanup.
  useEffect(() => {
    cal.current?.scrollIntoView?.({ block: "nearest" });
  }, []);
  const send = (e: DueDatePopoverEvent) => {
    if (done.current) return;
    const r = DueDatePopoverModel.step(s, e, saved);
    setS(r.state);
    if (!r.state.open) {
      done.current = true;
      if (r.save !== null) onSave(r.save);
      onClose();
    }
  };
  const days = DueDatePopoverModel.grid(s.month);
  const NAV = "flex h-6 w-6 items-center justify-center rounded-control text-muted hover:bg-input hover:text-fg focus-visible:outline-2 focus-visible:outline-accent";
  return (
    <div
      ref={root}
      className="relative shrink-0"
      data-testid="due-date-popover"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          send({ type: "escape" });
        }
      }}
      onBlur={(e) => {
        // Focus moving inside (field, month buttons, days) keeps it open. Leaving it (Tab or a click outside) closes.
        if (root.current && e.relatedTarget instanceof Node && root.current.contains(e.relatedTarget)) return;
        send({ type: e.relatedTarget ? "tabAway" : "outside" });
      }}
    >
      <input
        type="date"
        autoFocus
        defaultValue={saved}
        onChange={(e) => send({ type: "typed", value: e.target.value, cleared: e.target.value === "" && !e.target.validity.badInput })}
        aria-label={label}
        className="h-7 w-[124px] shrink-0 rounded-control border border-accent bg-input px-1 text-fg type-table focus:outline-none [&::-webkit-calendar-picker-indicator]:hidden"
        data-testid="due-date-input"
      />
      <div ref={cal} role="dialog" aria-label={`${label} calendar`} className="absolute right-0 z-30 mt-1 scroll-mb-24 w-[224px] rounded-control border border-line bg-card p-2 shadow-[0_12px_32px_rgba(0,0,0,.55)]">
        <div className="mb-1 flex items-center justify-between">
          <button type="button" className={NAV} aria-label="Previous month" tabIndex={-1} onClick={() => send({ type: "prevMonth" })} data-testid="due-date-prev">
            &#x2039;
          </button>
          <span className="type-table-strong text-fg" aria-live="polite" data-testid="due-date-month">
            {DueDatePopoverModel.monthLabel(s.month)}
          </span>
          <button type="button" className={NAV} aria-label="Next month" tabIndex={-1} onClick={() => send({ type: "nextMonth" })} data-testid="due-date-next">
            &#x203A;
          </button>
        </div>
        <div className="grid grid-cols-7 gap-0.5 text-center type-caption">
          {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
            <span key={i} aria-hidden className="text-muted">
              {d}
            </span>
          ))}
          {days.map((d, i) =>
            d ? (
              <button
                key={d}
                type="button"
                aria-label={d}
                tabIndex={-1}
                aria-pressed={d === s.draft}
                onClick={() => send({ type: "pickDay", date: d })}
                className={`h-6 rounded-control tabular-nums hover:bg-input focus-visible:outline-2 focus-visible:outline-accent ${d === s.draft ? "bg-accent text-white" : d === today ? "text-accent" : "text-fg"}`}
                data-testid="due-date-day"
              >
                {Number(d.slice(8))}
              </button>
            ) : (
              <span key={`b${i}`} />
            ),
          )}
        </div>
      </div>
    </div>
  );
}
