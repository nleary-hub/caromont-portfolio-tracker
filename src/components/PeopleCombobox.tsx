"use client";

import { useEffect, useRef, useState } from "react";
import type { PeopleRole } from "@/lib/people/PeopleDirectory";
import { PeopleComboboxModel, type ComboOption, type PeopleValue } from "@/lib/people/PeopleComboboxModel";
import { Chevron, FieldControlStyle } from "./FieldControl";

export interface PeopleComboboxProps {
  role: PeopleRole;
  /** Input id (the row label points at it). */
  id: string;
  /** Accessible name of the list, e.g. "Owner". */
  label: string;
  /** Names A to Z (PeopleDirectory). */
  options: readonly string[];
  value: PeopleValue;
  onPick: (next: PeopleValue) => void;
}

/**
 * Searchable owner or requester field (ARIA 1.2 combobox with a listbox popup). Click, type, or press
 * Down to open. Typing filters by substring (matched letters bold). Up and Down move the highlight,
 * Enter picks, Esc closes and restores the old value, clicking away discards the typed text. Rows come
 * from PeopleComboboxModel.
 */
export function PeopleCombobox({ role, id, label, options, value, onPick }: PeopleComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [filtering, setFiltering] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = `${id}-listbox`;
  const shown = PeopleComboboxModel.display(value);
  const offList = !open && PeopleComboboxModel.offList(value, options);

  const rows = PeopleComboboxModel.rows(role, options, query, filtering, value);
  const opts = PeopleComboboxModel.options(rows);
  const optionId = (o: ComboOption) => `${id}-opt-${o.key}`;
  const active = open && highlight >= 0 && highlight < opts.length ? opts[highlight] : null;

  useEffect(() => {
    if (active) document.getElementById(optionId(active))?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.key, open]);

  const openList = () => {
    const q = value.kind === "name" ? value.name : "";
    setQuery(q);
    setFiltering(false);
    setHighlight(PeopleComboboxModel.defaultHighlight(PeopleComboboxModel.rows(role, options, q, false, value), false));
    setOpen(true);
    // The field already shows the current name, so select it now: typing replaces it.
    inputRef.current?.select();
  };
  const close = () => {
    setOpen(false);
    setQuery("");
    setFiltering(false);
    setHighlight(-1);
  };
  const pick = (o: ComboOption) => {
    close();
    onPick(o.value);
  };
  const type = (text: string) => {
    setQuery(text);
    setFiltering(true);
    setOpen(true);
    setHighlight(PeopleComboboxModel.defaultHighlight(PeopleComboboxModel.rows(role, options, text, true, value), true));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) return openList();
      setHighlight((h) => PeopleComboboxModel.move(h, e.key === "ArrowDown" ? 1 : -1, opts.length));
    } else if (e.key === "Enter") {
      if (!open) return;
      e.preventDefault();
      if (active) pick(active);
    } else if (e.key === "Escape") {
      if (!open) return;
      e.preventDefault();
      e.stopPropagation(); // keep the drawer open
      close();
    } else if (e.key === "Tab") {
      if (open) close();
    }
  };

  return (
    <div className={FieldControlStyle.WRAP}>
      <input
        ref={inputRef}
        id={id}
        name={role === "owner" ? "owner" : "requester"}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={active ? optionId(active) : undefined}
        autoComplete="off"
        spellCheck={false}
        data-testid={`${role}-combobox`}
        value={open ? query : value.kind === "name" ? value.name : ""}
        placeholder={shown.text}
        onChange={(e) => type(e.target.value)}
        onClick={() => (open ? undefined : openList())}
        onKeyDown={onKeyDown}
        onBlur={close}
        aria-describedby={offList ? `${id}-offlist` : undefined}
        className={`${offList ? FieldControlStyle.BOX.replace("pr-7", "pr-[96px]") : FieldControlStyle.BOX} placeholder:text-muted ${shown.muted ? "text-muted" : "text-fg"}`}
      />
      {offList && (
        <span
          id={`${id}-offlist`}
          data-testid={`${role}-not-on-list`}
          className="pointer-events-none absolute top-1/2 right-7 -translate-y-1/2 rounded-[4px] border border-line bg-card px-1.5 text-[11px] leading-4 font-medium whitespace-nowrap text-muted"
        >
          {PeopleComboboxModel.NOT_ON_LIST}
        </span>
      )}
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        onMouseDown={(e) => {
          e.preventDefault();
          inputRef.current?.focus();
          if (open) close();
          else openList();
        }}
        className={FieldControlStyle.CHEVRON_SLOT}
      >
        <Chevron open={open} />
      </button>
      <ul
        id={listId}
        role="listbox"
        aria-label={label}
        hidden={!open}
        className="absolute left-0 z-20 mt-1 max-h-[280px] w-full min-w-[240px] overflow-y-auto rounded-card border border-line bg-card py-1 shadow-md"
      >
        {open &&
          rows.map((r, i) => {
            if (r.type === "divider") return <li key={`d${i}`} role="presentation" aria-hidden="true" className="my-1 border-t border-line" />;
            if (r.type === "message")
              return (
                <li key={`m${i}`} role="presentation" className="flex h-8 items-center px-3 text-muted">
                  {r.text}
                </li>
              );
            const isActive = active?.key === r.key;
            const tone = r.variant === "add" ? "text-accent" : r.variant === "pinned" && r.value.kind === "unset" ? "text-muted" : "text-fg";
            return (
              <li
                key={r.key}
                id={optionId(r)}
                role="option"
                aria-selected={isActive}
                aria-checked={r.current}
                data-variant={r.variant}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setHighlight(opts.indexOf(r))}
                onClick={() => pick(r)}
                className={`flex h-8 cursor-pointer items-center gap-2 px-3 ${tone} ${isActive ? "bg-row-selected" : ""}`}
              >
                {r.variant === "add" && (
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" className="flex-none">
                    <path d="M6 2v8M2 6h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  </svg>
                )}
                <span className="min-w-0 flex-1 truncate">
                  {r.segments.map((s, j) =>
                    s.match ? (
                      <span key={j} className="font-semibold">
                        {s.text}
                      </span>
                    ) : (
                      <span key={j}>{s.text}</span>
                    ),
                  )}
                </span>
                {r.current && (
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" className="flex-none text-accent" data-testid="current-check">
                    <path d="M2.5 6.5 5 9l4.5-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </li>
            );
          })}
      </ul>
      <span className="sr-only" aria-live="polite">
        {open ? (rows.find((r) => r.type === "message") as { text: string } | undefined)?.text ?? "" : ""}
      </span>
    </div>
  );
}
