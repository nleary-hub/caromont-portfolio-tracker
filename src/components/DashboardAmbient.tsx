"use client";

import { useEffect, useId, useRef } from "react";

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

/** A drawing head writes each P–QRS–T beat; only its fading history is visible. */
export function SummaryHeartbeat({ tilesKey }: { tilesKey: string }) {
  const ref = useRef<SVGSVGElement>(null);
  const maskId = useId();
  useEffect(() => {
    const svg = ref.current;
    const summary = svg?.closest<HTMLElement>(".pb-summary");
    if (!svg || !summary) return;
    const trace = svg.querySelector<SVGPathElement>(".pb-ecg-pulse")!;
    const head = svg.querySelector<SVGCircleElement>(".pb-ecg-head")!;
    const fade = svg.querySelector<SVGRectElement>(".pb-ecg-fade")!;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    // One clock drives both the drawing and background responses. WAAPI also supports pausing.
    let clock: Animation | undefined;
    let frame = 0;
    let centers: { glow: HTMLElement; x: number }[] = [];
    const draw = () => {
      const x = Number(clock?.currentTime ?? 0) % SummaryBeat.SWEEP_MS / SummaryBeat.SWEEP_MS * 1440;
      trace.setAttribute("d", SummaryBeat.path(Math.max(0, x - SummaryBeat.TRAIL_WIDTH), x));
      head.setAttribute("cx", String(x));
      head.setAttribute("cy", String(SummaryBeat.y(x)));
      fade.setAttribute("x", String(x - SummaryBeat.TRAIL_WIDTH));
      for (const { glow, x: center } of centers) {
        // The wash arrives with the head and fades gently behind it, never lighting the border.
        const distance = x - center;
        const opacity = distance < -70 || distance > 170 ? 0 :
          distance < 0 ? 0.22 * (1 + distance / 70) : 0.22 * (1 - distance / 170);
        glow.style.opacity = String(opacity);
      }
      frame = requestAnimationFrame(draw);
    };
    const place = () => {
      cancelAnimationFrame(frame);
      clock?.cancel();
      const box = svg.getBoundingClientRect();
      centers = [...summary.querySelectorAll<HTMLElement>(".pb-tile")].map(tile => {
        const rect = tile.getBoundingClientRect();
        const x = box.width ? (rect.left + rect.width / 2 - box.left) / box.width * 1440 : 0;
        tile.style.setProperty("--pb-beat-delay", String(x / 1440 * SummaryBeat.SWEEP_MS));
        const glow = tile.querySelector<HTMLElement>(".pb-tile-beat")!;
        glow.style.opacity = "0";
        return { glow, x };
      });
      summary.setAttribute("data-pb-beat", "");
      if (!reduced.matches) {
        clock = svg.animate([{ opacity: 1 }, { opacity: 1 }], { duration: SummaryBeat.SWEEP_MS, iterations: Infinity });
        draw();
      }
    };
    const observer = new ResizeObserver(place);
    observer.observe(summary);
    reduced.addEventListener("change", place);
    place();
    return () => {
      observer.disconnect();
      reduced.removeEventListener("change", place);
      cancelAnimationFrame(frame);
      clock?.cancel();
      summary.removeAttribute("data-pb-beat");
      for (const tile of summary.querySelectorAll<HTMLElement>(".pb-tile")) tile.style.removeProperty("--pb-beat-delay");
    };
  }, [tilesKey]);
  return (
    <svg ref={ref} className="pb-ecg" viewBox="0 0 1440 40" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={`${maskId}-fade`}><stop stopColor="white" stopOpacity="0" /><stop offset="1" stopColor="white" /></linearGradient>
        <mask id={maskId} maskUnits="userSpaceOnUse"><rect className="pb-ecg-fade" x={-SummaryBeat.TRAIL_WIDTH} width={SummaryBeat.TRAIL_WIDTH} height="40" fill={`url(#${maskId}-fade)`} /></mask>
      </defs>
      <path className="pb-ecg-base" d={SummaryBeat.path(0, 1440)} />
      <path className="pb-ecg-pulse" mask={`url(#${maskId})`} />
      <circle className="pb-ecg-head" r="1.8" cx="0" cy="28" />
    </svg>
  );
}

export const SummaryBeat = {
  // Spacing sets cadence independently of sweep speed: two beats in a four-second sweep.
  SWEEP_MS: 4000,
  BEAT_SPACING: 720,
  TRAIL_WIDTH: 360,
  /** A small Q, tall narrow R and crisp S, with smooth P/T and a long quiet baseline. */
  y(x: number): number {
    const phase = ((x % this.BEAT_SPACING) + this.BEAT_SPACING) % this.BEAT_SPACING;
    if (phase >= 24 && phase < 48) return 28 - 5 * Math.sin((phase - 24) / 24 * Math.PI);
    if (phase >= 64 && phase < 68) return 28 + (phase - 64) / 4 * 2;
    if (phase >= 68 && phase < 74) return 30 - (phase - 68) / 6 * 28;
    if (phase >= 74 && phase < 80) return 2 + (phase - 74) / 6 * 34;
    if (phase >= 80 && phase < 88) return 36 - (phase - 80) / 8 * 8;
    if (phase >= 112 && phase < 154) return 28 - 9 * Math.sin((phase - 112) / 42 * Math.PI);
    return 28;
  },
  path(start: number, end: number): string {
    const points = [`M${start.toFixed(2)} ${this.y(start).toFixed(2)}`];
    for (let x = Math.ceil(start); x < end; x++) points.push(`L${x} ${this.y(x).toFixed(2)}`);
    points.push(`L${end.toFixed(2)} ${this.y(end).toFixed(2)}`);
    return points.join(" ");
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
