"use client";

import { useEffect, useRef } from "react";

/** Fixed star positions: pseudo-random but identical on the server and in the browser. */
const STARS = Array.from({ length: 16 }, (_, i) => ({
  left: (i * 37 + 11) % 100,
  top: (i * 23 + 5) % 92,
  delay: ((i * 7) % 10) * 0.42,
}));

/**
 * Option B ambient layer behind the dashboard: a faint grid, a slow glow and a few stars.
 * One fixed, non-interactive layer under all content (styles in src/styles/polish.css); static under reduced motion.
 */
export function DashboardAmbient() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    const page = el?.closest<HTMLElement>(".pb-page");
    if (!el || !page) return;
    // No backdrop-filter: mark the page solid so no glass, sheen or glow rules apply (polish.css).
    if (!Glass.supported()) page.setAttribute("data-pb-solid", "");
  }, []);
  return (
    <div ref={ref} className="pb-ambient" aria-hidden="true">
      <div className="pb-grid" />
      <div className="pb-glow" />
      {STARS.map((s, i) => (
        <i key={i} className="pb-star" style={{ left: `${s.left}%`, top: `${s.top}%`, animationDelay: `${s.delay}s` }} />
      ))}
    </div>
  );
}

/** A quiet trace across the tiles' bottom padding, above their surfaces but clear of all text. */
export function SummaryHeartbeat({ tilesKey }: { tilesKey: string }) {
  const ref = useRef<SVGSVGElement>(null);
  useEffect(() => {
    const svg = ref.current;
    const summary = svg?.closest<HTMLElement>(".pb-summary");
    if (!svg || !summary) return;
    const place = () => {
      // Restart both CSS timelines together when the visible tiles or their geometry changes.
      summary.removeAttribute("data-pb-beat");
      const box = svg.getBoundingClientRect();
      for (const tile of summary.querySelectorAll<HTMLElement>(".pb-tile")) {
        const rect = tile.getBoundingClientRect();
        const fraction = box.width ? (rect.left + rect.width / 2 - box.left) / box.width : 0;
        tile.style.setProperty("--pb-beat-delay", `${SummaryBeat.delay(fraction)}ms`);
      }
      // Flush the stopped state so all animations resume with one origin, including newly shown tiles.
      void summary.offsetWidth;
      summary.setAttribute("data-pb-beat", "");
    };
    const observer = new ResizeObserver(place);
    observer.observe(summary);
    place();
    return () => {
      observer.disconnect();
      summary.removeAttribute("data-pb-beat");
    };
  }, [tilesKey]);
  return (
    <svg ref={ref} className="pb-ecg" viewBox="0 0 1440 10" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <path className="pb-ecg-base" d={SummaryBeat.STATIC_PATH} />
      <g className="pb-ecg-pulse"><path d={SummaryBeat.MOVING_PATH} /></g>
    </svg>
  );
}

// Stylized P wave, Q dip, sharp R peak/S dip, and rounded T wave. R is at the moving trace's center.
const PQRST = "h13 q4 0 7 -2 q4 -2 8 2 h10 l5 2 7.4 -7 6.6 8 5 -3 h10 q8 -5 18 0";
export const SummaryBeat = {
  MOVING_PATH: `M0 6 ${PQRST} h10.8`,
  STATIC_PATH: Array.from({ length: 8 }, (_, i) => `M${i * 180} 6 ${PQRST} h90`).join(" "),
  /** A 7%-wide pulse enters from outside the trace; tile glow peaks when its center arrives. */
  delay(fraction: number): number {
    return 8000 * ((fraction * 1000 + 35) / 1070) - 160;
  },
};

/**
 * While the side panel is open: dims the page (DIM_MAX) everywhere except the selected row, which stays lit.
 * A non-interactive box tracks the row (clipped to the table's scroll area); its spread shadow is the dim.
 */
export function DrawerSpotlight({ rowId }: { rowId: string | null }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame = 0;
    const place = () => {
      frame = 0;
      const tr = rowId ? document.querySelector<HTMLElement>(`tr[data-row-key="${CSS.escape(rowId)}"]`) : null;
      const scroller = tr?.closest<HTMLElement>("[data-pb-scroll]");
      if (!tr || !scroller) {
        el.style.cssText = "top:0;left:0;width:0;height:0";
        return;
      }
      const r = tr.getBoundingClientRect();
      const box = scroller.getBoundingClientRect();
      const head = scroller.querySelector("thead")?.getBoundingClientRect().height ?? 0;
      const top = Math.max(r.top, box.top + head);
      const bottom = Math.min(r.bottom, box.bottom);
      const height = Math.max(0, bottom - top);
      el.style.cssText = `top:${height ? top : box.top}px;left:${box.left}px;width:${height ? box.width : 0}px;height:${height}px`;
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(place);
    };
    place();
    window.addEventListener("resize", schedule);
    document.addEventListener("scroll", schedule, true);
    const observer = new ResizeObserver(schedule);
    observer.observe(document.body);
    // Sorting/manual ordering moves existing rows without resizing the body. Observe the table's
    // content too, including filtering and text changes that can move the selected row.
    const scroller = document.querySelector<HTMLElement>(".pb-page [data-pb-scroll]");
    const mutations = new MutationObserver(schedule);
    if (scroller) {
      mutations.observe(scroller, { childList: true, subtree: true, characterData: true });
      observer.observe(scroller);
      const table = scroller.querySelector("table");
      if (table) observer.observe(table);
    }
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("scroll", schedule, true);
      observer.disconnect();
      mutations.disconnect();
    };
  }, [rowId]);
  return <div ref={ref} className="pb-spot" aria-hidden="true" />;
}

/** Dim alpha: preserves at least 4.5:1 for muted dashboard text after compositing both text and surface. */
export const DIM_MAX = 0.15;

export const Glass = {
  /** Whether the browser can frost (backdrop-filter, prefixed or not). */
  supported(): boolean {
    return typeof CSS !== "undefined" && (CSS.supports("backdrop-filter", "blur(1px)") || CSS.supports("-webkit-backdrop-filter", "blur(1px)"));
  },
};
