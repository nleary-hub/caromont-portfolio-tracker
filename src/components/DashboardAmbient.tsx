"use client";

import { useEffect, useRef } from "react";
import { ECG_PATH, ECG_VIEWBOX } from "@/lib/ui/Heartbeat";

/** Fixed star positions: pseudo-random but identical on the server and in the browser. */
const STARS = Array.from({ length: 16 }, (_, i) => ({
  left: (i * 37 + 11) % 100,
  top: (i * 23 + 5) % 92,
  delay: ((i * 7) % 10) * 0.42,
}));

/**
 * Option B ambient layer behind the dashboard: a faint grid, a slow glow, a few stars and the sign-in heartbeat line.
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
    // Run the heartbeat baseline through the gap between the summary tiles and the toolbar.
    const place = () => {
      const tiles = page.querySelector('[aria-label="Status summary"]')?.getBoundingClientRect();
      const toolbar = page.querySelector('[aria-label="Department filter"]')?.getBoundingClientRect();
      if (tiles && toolbar) el.style.setProperty("--pb-ecg-top", `${Math.round(Glass.ecgTop(tiles.bottom, toolbar.top))}px`);
      else el.style.removeProperty("--pb-ecg-top");
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(page);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={ref} className="pb-ambient" aria-hidden="true">
      <div className="pb-grid" />
      <div className="pb-glow" />
      {STARS.map((s, i) => (
        <i key={i} className="pb-star" style={{ left: `${s.left}%`, top: `${s.top}%`, animationDelay: `${s.delay}s` }} />
      ))}
      <svg className="pb-ecg" viewBox={ECG_VIEWBOX} preserveAspectRatio="none">
        <path className="pb-ecg-base" d={ECG_PATH} />
        <path className="pb-ecg-pulse" d={ECG_PATH} />
      </svg>
    </div>
  );
}

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

/** Height of the dashboard heartbeat line (px); the path's baseline sits at half of it (polish.css .pb-ecg). */
export const ECG_HEIGHT = 84;

export const Glass = {
  /** Whether the browser can frost (backdrop-filter, prefixed or not). */
  supported(): boolean {
    return typeof CSS !== "undefined" && (CSS.supports("backdrop-filter", "blur(1px)") || CSS.supports("-webkit-backdrop-filter", "blur(1px)"));
  },
  /** Top of the heartbeat line so its baseline is centered between the tiles' bottom and the toolbar's top. */
  ecgTop(tilesBottom: number, toolbarTop: number): number {
    return (tilesBottom + toolbarTop) / 2 - ECG_HEIGHT / 2;
  },
};
