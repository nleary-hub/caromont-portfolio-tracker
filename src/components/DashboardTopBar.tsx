"use client";

import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject, type ReactNode, type RefObject } from "react";
import { DateFormat } from "@/lib/dashboard/DashboardViewModel";
import type { ServiceLineValue } from "@/lib/domain/ServiceLine";
import { TopBarCopy } from "@/lib/layout/TopBarCopy";
import { TopBarFit } from "@/lib/layout/TopBarFit";
import { OnDemandPdfLink } from "@/lib/report/OnDemandPdfLink";
import { MainNav } from "./MainNav";
import { ServiceLineLabel } from "./ServiceLineLabel";
import { TopBarFrame } from "./TopBarFrame";
import { useTopBarFit } from "./TopBarFitContext";

export interface TopBarReport {
  /** YYYY-MM-DD */
  reportDate: string;
  periodStart: string;
  periodEnd: string;
}

/**
 * The dashboard top bar. Row 1, in fixed order: logo and line name (or switcher), report chip, search, Dashboard view
 * (admins), nav, Generate PDF now (pinned right), admin menu, account. When it doesn't fit, it steps down one step at
 * a time (TopBarFit): short name, chip without its range, search icon, Dashboard view icon, nav on a second row, then
 * an ellipsis on the name. Generate, the logo and the switcher chevron are never hidden.
 */
export function DashboardTopBar({
  serviceLine,
  switcher,
  latestReport,
  query,
  onQuery,
  focusSearchRef,
  viewPicker,
  viewKey = "",
  closedQuery,
  pdfDepartments,
  adminMenu,
  account,
}: {
  serviceLine: ServiceLineValue;
  switcher?: ReactNode;
  latestReport: TopBarReport | null;
  query: string;
  onQuery: (q: string) => void;
  /** Set here: what the "/" shortcut calls (focus the field, or open it when it is an icon). */
  focusSearchRef: MutableRefObject<() => void>;
  /** Admins: the Dashboard view picker, compact at step 4. */
  viewPicker?: (compact: boolean) => ReactNode;
  /** Changes when the picker's trigger text changes (hidden count), so the bar refits. */
  viewKey?: string;
  closedQuery: string;
  pdfDepartments: Parameters<typeof OnDemandPdfLink.href>[0];
  adminMenu?: ReactNode;
  account: ReactNode;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const pdfRef = useRef<HTMLAnchorElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const iconRef = useRef<HTMLButtonElement>(null);
  const usable = TopBarFit.usable({ chipDate: Boolean(latestReport), viewIcon: Boolean(viewPicker) }, serviceLine);
  const contentKey = [serviceLine.name, serviceLine.shortName, latestReport?.reportDate ?? "", viewKey, Boolean(adminMenu)].join("|");
  const fit = useTopBarFit(rowRef, usable, contentKey);
  const has = (s: Parameters<typeof TopBarFit.has>[1]) => TopBarFit.has(fit.level, s);
  const collapsed = has("searchIcon");
  const [searchOpen, setSearchOpen] = useState(false);
  const overlay = collapsed && searchOpen;

  useEffect(() => {
    focusSearchRef.current = collapsed ? () => setSearchOpen(true) : () => searchRef.current?.focus();
  }, [collapsed, focusSearchRef]);

  const closeSearch = (refocus: boolean) => {
    setSearchOpen(false);
    if (refocus) requestAnimationFrame(() => iconRef.current?.focus());
  };

  const range = latestReport ? `${DateFormat.short(latestReport.periodStart)} – ${DateFormat.long(latestReport.periodEnd)}` : null;
  const chipShort = has("chipDate");
  // While the search field is open over the bar, what it covers is hidden (not removed), so nothing moves.
  const covered = overlay ? "invisible" : "";

  return (
    <TopBarFrame
      rowRef={rowRef}
      fit={fit}
      lockup={switcher ?? <ServiceLineLabel value={serviceLine} />}
      navRow={<MainNav active="dashboard" closedQuery={closedQuery} row />}
    >
      <button
        ref={chipRef}
        type="button"
        disabled
        title={chipShort ? TopBarCopy.reportTip(range) : TopBarCopy.REPORT_SOON}
        className={`flex h-8 shrink-0 items-center gap-2 rounded-control border border-line bg-input pr-2.5 pl-3 whitespace-nowrap text-muted ${covered}`}
        data-testid="report-chip"
        data-compact={chipShort ? "" : undefined}
      >
        {latestReport ? (
          <>
            <span className="type-table-strong text-fg">Report of {DateFormat.short(latestReport.reportDate)}</span>
            <span className={chipShort ? "sr-only" : "type-caption"}>{range}</span>
          </>
        ) : (
          <span className="type-table-strong text-fg">No reports yet</span>
        )}
      </button>
      <div className="flex-1" />
      {collapsed ? (
        <button
          ref={iconRef}
          type="button"
          aria-label={TopBarCopy.SEARCH_ICON}
          title={TopBarCopy.SEARCH_ICON}
          aria-expanded={overlay}
          onClick={() => setSearchOpen(true)}
          className={`tap-44 grid size-8 shrink-0 place-items-center rounded-control border bg-input ${query ? "border-accent text-fg" : "border-line text-muted"} ${covered}`}
          data-testid="search-icon"
        >
          <SearchGlyph />
        </button>
      ) : (
        <label className="flex h-8 w-80 min-w-40 shrink items-center gap-2 rounded-control border border-line bg-input pr-2.5 pl-3 text-muted type-table">
          <SearchGlyph />
          <SearchInput inputRef={searchRef} query={query} onQuery={onQuery} />
          <kbd className="rounded border border-line px-1 type-caption">/</kbd>
        </label>
      )}
      {viewPicker && <div className={`shrink-0 ${covered}`}>{viewPicker(has("viewIcon"))}</div>}
      {!has("navRow") && (
        <div className={`shrink-0 ${covered}`}>
          <MainNav active="dashboard" closedQuery={closedQuery} />
        </div>
      )}
      {/* Everyone who can see the dashboard: only the departments they are viewing (the server keeps only ones
          they can see; an admin viewing every department gets the admin report setting; DraftReportService). */}
      <a
        ref={pdfRef}
        href={OnDemandPdfLink.href(pdfDepartments)}
        download
        title={OnDemandPdfLink.TOOLTIP}
        className="tap-44 flex h-8 shrink-0 items-center rounded-control bg-accent px-3.5 whitespace-nowrap text-white type-table-strong"
        data-testid="generate-pdf"
      >
        Generate PDF now
      </a>
      {adminMenu && (
        // 12px left of the user block (header gap is 16px).
        <div className="-mr-1 shrink-0">{adminMenu}</div>
      )}
      {account}
      {overlay && (
        <SearchOverlay rowRef={rowRef} fromRef={chipRef} toRef={pdfRef} inputRef={searchRef} onClose={closeSearch}>
          <SearchInput inputRef={searchRef} query={query} onQuery={onQuery} />
        </SearchOverlay>
      )}
    </TopBarFrame>
  );
}

function SearchGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden className="shrink-0">
      <circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M9.5 9.5L13 13" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function SearchInput({ inputRef, query, onQuery }: { inputRef: RefObject<HTMLInputElement | null>; query: string; onQuery: (q: string) => void }) {
  return (
    <input
      ref={inputRef}
      value={query}
      onChange={(e) => onQuery(e.target.value)}
      placeholder={TopBarCopy.SEARCH_PLACEHOLDER}
      aria-label={TopBarCopy.SEARCH_LABEL}
      className="min-w-0 flex-1 bg-transparent text-fg placeholder:text-muted focus:outline-none"
    />
  );
}

/**
 * Step 3: the search field opened over row 1, from the report chip to just before Generate PDF now (which stays
 * visible). Closes on Esc, the close button, or when focus leaves it; the query stays applied.
 */
function SearchOverlay({
  rowRef,
  fromRef,
  toRef,
  inputRef,
  onClose,
  children,
}: {
  rowRef: RefObject<HTMLDivElement | null>;
  fromRef: RefObject<HTMLElement | null>;
  toRef: RefObject<HTMLElement | null>;
  inputRef: RefObject<HTMLInputElement | null>;
  onClose: (refocus: boolean) => void;
  children: ReactNode;
}) {
  const [span, setSpan] = useState<{ left: number; right: number } | null>(null);
  useLayoutEffect(() => {
    const row = rowRef.current;
    const from = fromRef.current;
    const to = toRef.current;
    if (!row || !from || !to) return;
    const gap = parseFloat(getComputedStyle(row).columnGap) || 16;
    setSpan({ left: from.offsetLeft, right: row.clientWidth - to.offsetLeft + gap });
  }, [rowRef, fromRef, toRef]);
  // Focus once placed (it is invisible until then, and an invisible field can't take focus).
  useEffect(() => {
    if (span) inputRef.current?.focus();
  }, [span, inputRef]);
  return (
    <div
      role="search"
      className="absolute inset-y-0 z-20 flex items-center gap-2"
      style={span ? { left: span.left, right: span.right } : { visibility: "hidden" }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose(true);
        }
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onClose(false);
      }}
      data-testid="search-overlay"
    >
      <label className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-control border border-accent bg-input pr-2.5 pl-3 text-muted type-table">
        <SearchGlyph />
        {children}
        <kbd className="rounded border border-line px-1 type-caption">/</kbd>
      </label>
      <button type="button" aria-label={TopBarCopy.SEARCH_CLOSE} title={TopBarCopy.SEARCH_CLOSE} onClick={() => onClose(true)} className="tap-44 grid size-8 shrink-0 place-items-center rounded-control text-muted hover:bg-row-selected hover:text-fg">
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
          <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
