"use client";

import { createContext, useContext, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import { TopBarFit, type TopBarStep } from "@/lib/layout/TopBarFit";

/**
 * The fit level of the top bar around this component (TopBarFit). Null outside a measured bar: the name then uses
 * the plain CSS rule (short name below the `topbar` breakpoint), as on the admin pages.
 */
export const TopBarFitContext = createContext<TopBarFitValue | null>(null);

export interface TopBarFitValue {
  level: number;
  /** Step 8: the widest the name may be (px), measured so the bar fits; CSS keeps ~8 characters as the floor. */
  nameMax: number | null;
}

export function useTopBarLevel(): number | null {
  return useContext(TopBarFitContext)?.level ?? null;
}

export function useTopBarNameMax(): number | null {
  return useContext(TopBarFitContext)?.nameMax ?? null;
}

/** Marks the element that holds the line name, so step 8 can measure it. */
export const TOP_BAR_NAME_ATTR = "data-top-bar-name";

/**
 * Measures the bar's first row and steps down (TopBarFit.next) one step per render until it no longer overflows.
 * Runs in layout effects, so the steps apply before the browser paints. When the row gets wider the bar starts again
 * from the full layout; when it gets narrower it continues from the current level. `contentKey` refits when what the
 * bar shows changes (hidden count, report, line). `measured` is false until the first measurement (server render and
 * hydration), when the row clips its own overflow so the page never scrolls sideways before the fit runs.
 */
export function useTopBarFit(rowRef: RefObject<HTMLElement | null>, usable: readonly TopBarStep[], contentKey: string): TopBarFitValue & { measured: boolean } {
  // `run` counts refits, so a refit that starts from the same level still measures again.
  const [state, setState] = useState<{ level: number; width: number; run: number; nameMax: number | null }>({ level: 0, width: -1, run: 0, nameMax: null });
  const usableKey = usable.join(",");

  useLayoutEffect(() => {
    const el = rowRef.current;
    if (!el) return;
    const update = () => {
      const w = Math.round(el.getBoundingClientRect().width);
      setState((s) => (s.width === w ? s : { level: w > s.width ? 0 : s.level, width: w, run: s.run + 1, nameMax: null }));
    };
    update();
    // flushSync: resize observations arrive before paint, so the refit shows in the same frame.
    const ro = new ResizeObserver(() => flushSync(update));
    ro.observe(el);
    // Web fonts can change widths after the first fit.
    document.fonts?.ready.then(() => setState((s) => ({ ...s, level: 0, run: s.run + 1, nameMax: null }))).catch(() => {});
    return () => ro.disconnect();
  }, [rowRef]);

  const firstKey = useRef(true);
  useLayoutEffect(() => {
    if (firstKey.current) {
      firstKey.current = false;
      return;
    }
    setState((s) => ({ ...s, level: 0, run: s.run + 1, nameMax: null }));
  }, [contentKey, usableKey]);

  useLayoutEffect(() => {
    const el = rowRef.current;
    if (!el || state.width < 0) return;
    const excess = el.scrollWidth - el.clientWidth;
    const next = TopBarFit.next(state.level, excess > 1, usableKey.split(",") as TopBarStep[]);
    if (next !== state.level) {
      setState((s) => ({ ...s, level: next }));
      return;
    }
    // Step 8, once: narrow the name by exactly the overflow (its CSS min-width keeps ~8 characters).
    if (excess > 1 && state.nameMax === null && TopBarFit.has(state.level, "truncateName")) {
      const name = el.querySelector(`[${TOP_BAR_NAME_ATTR}]`);
      if (name) setState((s) => ({ ...s, nameMax: Math.max(0, Math.floor(name.getBoundingClientRect().width - excess)) }));
    }
  }, [rowRef, state.level, state.width, state.run, state.nameMax, usableKey]);

  return { level: state.level, nameMax: state.nameMax, measured: state.width >= 0 };
}
