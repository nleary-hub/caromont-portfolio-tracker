"use client";

import { useEffect, useRef, useState } from "react";
import type { ProjectStatus } from "@/generated/prisma/enums";
import { Flags, StatusPill } from "@/components/StatusPill";
import { SignInBackdrop as Backdrop, type BackdropRow } from "@/lib/auth/SignInBackdrop";
import { ECG_PATH } from "@/lib/ui/Heartbeat";

// Status foreground colors (tokens.css) for the drifting particles.
const PARTICLE_COLORS = ["var(--status-not-started-dark-fg)", "var(--status-on-track-dark-fg)", "var(--status-at-risk-dark-fg)", "var(--status-on-hold-dark-fg)", "var(--status-complete-dark-fg)", "var(--flag-changed-dark-fg)"];

/** Fixed particle positions: pseudo-random but identical on the server and in the browser. */
const PARTICLES = Array.from({ length: 14 }, (_, i) => ({
  left: (i * 47 + 13) % 100,
  top: (i * 29 + 7) % 88,
  opacity: 0.2 + ((i * 7) % 5) * 0.05,
  dx: ((i * 53) % 41) - 20,
  dy: ((i * 31) % 41) - 20,
  delay: `${(0.8 + ((i * 11) % 30) / 10).toFixed(2)}s, ${((i * 17) % 60) / 10}s`,
  color: PARTICLE_COLORS[i % PARTICLE_COLORS.length],
}));

class Motion {
  static reduced(): boolean {
    return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }
}

/** Every few seconds one row's status pill changes, as if the portfolio were live. Both copies of a row share it. */
function useLiveStatuses(columns: BackdropRow[][]): Record<string, ProjectStatus> {
  const [statuses, setStatuses] = useState<Record<string, ProjectStatus>>({});
  useEffect(() => {
    if (Motion.reduced()) return;
    const ids = columns.flat().map((r) => r.id);
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const id = ids[Math.floor(Math.random() * ids.length)];
      const status = Backdrop.STATUSES[Math.floor(Math.random() * Backdrop.STATUSES.length)];
      setStatuses((prev) => ({ ...prev, [id]: status }));
      timer = setTimeout(tick, 900 + Math.random() * 1200);
    };
    timer = setTimeout(tick, 1600);
    return () => clearTimeout(timer);
  }, [columns]);
  return statuses;
}

function WallRow({ row, status }: { row: BackdropRow; status: ProjectStatus }) {
  return (
    <div className="si-row">
      <span className="si-row-name">{row.name}</span>
      <span className="si-prog">
        <span style={{ "--pct": row.progress } as React.CSSProperties} />
      </span>
      {row.flag && <Flags changed={row.flag === "changed"} overdue={row.flag === "overdue"} />}
      <StatusPill status={status} />
    </div>
  );
}

/**
 * Counts up from 0 once the statement has faded in (it is still invisible when this resets to 0). Renders the final
 * value first, for no JS and reduced motion. Writes the digits straight to the DOM: no re-render per frame.
 */
function CountUp({ value }: { value: number }) {
  const el = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const node = el.current;
    if (!node || Motion.reduced()) return;
    let frame = 0;
    let done = false;
    node.textContent = "0";
    const start = setTimeout(() => {
      const t0 = performance.now();
      const step = (now: number) => {
        if (done) return;
        const p = Math.min((now - t0) / 1400, 1);
        node.textContent = String(Math.round((1 - Math.pow(1 - p, 3)) * value));
        if (p < 1) frame = requestAnimationFrame(step);
      };
      frame = requestAnimationFrame(step);
    }, 1200);
    // Land on the final value even if the browser throttles animation frames (background tab).
    const settle = setTimeout(() => {
      done = true;
      node.textContent = String(value);
    }, 2800);
    return () => {
      done = true;
      clearTimeout(start);
      clearTimeout(settle);
      cancelAnimationFrame(frame);
      node.textContent = String(value);
    };
  }, [value]);
  return <span ref={el}>{value}</span>;
}

/**
 * Everything behind the /signin card: grid, the live portfolio wall (bottom, fading out before the heartbeat
 * line), the heartbeat trace, the pulse orb behind the card, and the "Every project. One view." statement.
 * Purely decorative (aria-hidden); all motion stops under prefers-reduced-motion (see signin.css).
 */
export function SignInBackdrop() {
  const [columns] = useState(() => Backdrop.columns());
  const statuses = useLiveStatuses(columns);
  const orb = useRef<HTMLDivElement>(null);
  const particles = useRef<HTMLDivElement>(null);

  // Cursor parallax: the orb and particles drift a few pixels with the pointer.
  useEffect(() => {
    if (Motion.reduced()) return;
    const onMove = (e: MouseEvent) => {
      const cx = e.clientX / window.innerWidth - 0.5;
      const cy = e.clientY / window.innerHeight - 0.5;
      if (orb.current) orb.current.style.translate = `${cx * 18}px ${cy * 18}px`;
      particles.current?.querySelectorAll<HTMLElement>(".si-pt").forEach((el, i) => {
        const depth = ((i % 5) + 1) * 4;
        el.style.translate = `${cx * depth}px ${cy * depth}px`;
      });
    };
    window.addEventListener("mousemove", onMove, { passive: true });
    return () => window.removeEventListener("mousemove", onMove);
  }, []);

  return (
    <div className="si-backdrop" aria-hidden="true">
      <div className="si-grid" />

      <div className="si-wall">
        <div className="si-wall-cols">
          {columns.map((rows, c) => (
            <div key={c} className="si-wall-col">
              <div className="si-wall-track" style={{ "--dur": `${Backdrop.COLUMN_SPEEDS_S[c]}s`, animationDelay: `${-c * 4}s` } as React.CSSProperties}>
                {[0, 1].map((copy) =>
                  rows.map((row) => <WallRow key={`${copy}-${row.id}`} row={row} status={statuses[row.id] ?? row.status} />),
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      <svg className="si-ecg" viewBox="0 0 1440 280" preserveAspectRatio="none">
        <path className="si-ecg-trace" d={ECG_PATH} />
        <path className="si-ecg-head" d={ECG_PATH} />
      </svg>
      <span className="si-pop si-pop-a">
        <StatusPill status="OnTrack" />
      </span>
      <span className="si-pop si-pop-b">
        <StatusPill status="Complete" />
      </span>

      <div className="si-orb" ref={orb}>
        <div className="si-orb-core" />
        <span className="si-ring si-ring-1" />
        <span className="si-ring si-ring-2" />
      </div>
      <div className="si-particles" ref={particles}>
        {PARTICLES.map((p, i) => (
          <span
            key={i}
            className="si-pt"
            style={{ left: `${p.left}%`, top: `${p.top}%`, background: p.color, "--o": p.opacity, "--dx": `${p.dx}px`, "--dy": `${p.dy}px`, animationDelay: p.delay } as React.CSSProperties}
          />
        ))}
      </div>

      <div className="si-statement">
        <p className="si-statement-text">
          {Backdrop.STATEMENT[0]}
          <br />
          {Backdrop.STATEMENT[1]}
        </p>
        <div className="si-metrics">
          {Backdrop.METRICS.map((m) => (
            <div key={m.label}>
              <div className="si-metric-value">
                <CountUp value={m.value} />
              </div>
              <div className="si-metric-label">{m.label}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
