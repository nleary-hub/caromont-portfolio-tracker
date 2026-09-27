"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";

export interface ActionToastValue {
  text: string;
  link?: { href: string; label: string };
  error?: boolean;
}

/** A row leaving a list (Restore to active, a project set to Cancelled): fades out before the list drops it. */
export class RowFade {
  static readonly MS = 300;

  static out(id: string): void {
    if (typeof document === "undefined") return;
    const el = document.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(id)}"]`);
    el?.animate?.([{ opacity: 1 }, { opacity: 0 }], { duration: RowFade.MS, fill: "forwards" });
  }
}

/** Toast at the bottom center (the Admin > People style): the message and an optional link. Disappears after 6 s. */
export function ActionToast({ value, onDone, ms = 6000 }: { value: ActionToastValue; onDone: () => void; ms?: number }) {
  const done = useRef(onDone);
  useEffect(() => {
    done.current = onDone;
  });
  useEffect(() => {
    const t = window.setTimeout(() => done.current(), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return (
    <div
      role={value.error ? "alert" : "status"}
      data-testid="action-toast"
      className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-4 rounded-card border border-line bg-(--dark-input) px-4 py-2.5 text-fg shadow-lg type-table"
    >
      <span className={value.error ? "text-danger" : undefined}>{value.text}</span>
      {value.link && (
        <Link href={value.link.href} className="whitespace-nowrap text-accent type-table-strong hover:underline">
          {value.link.label}
        </Link>
      )}
    </div>
  );
}
