"use client";

import { useMemo, useState } from "react";
import s from "@/components/rbac/Rbac.module.css";

export interface ViewerProjectRow {
  id: string;
  name: string;
  department: string;
  owner: string;
  status: string;
  statusLabel: string;
  percent: number | null;
  target: string | null;
  blocked: boolean;
}

const TONES: Record<string, { fg: string; bg: string }> = {
  OnTrack: { fg: "#22c55e", bg: "rgba(34,197,94,.12)" },
  AtRisk: { fg: "#f59e0b", bg: "rgba(245,158,11,.12)" },
  OffTrack: { fg: "#ef4444", bg: "rgba(239,68,68,.12)" },
  OnHold: { fg: "#a78bfa", bg: "rgba(167,139,250,.12)" },
};
const NEUTRAL = { fg: "#a3aab8", bg: "rgba(255,255,255,.07)" };

function shortDate(iso: string | null): string {
  if (!iso) return "Not set";
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** The Viewer dashboard (dashboard-viewer-d): read-only KPIs, filters and the project table. No edit controls. */
export function ViewerDashboard(props: { rows: ViewerProjectRow[]; updatedLabel: string; pdfHref: string; projectHrefBase?: string }) {
  const [q, setQ] = useState("");
  const [dept, setDept] = useState("all");
  const [status, setStatus] = useState("all");
  const [owner, setOwner] = useState("all");
  const { rows } = props;
  const opts = useMemo(
    () => ({
      depts: [...new Set(rows.map((r) => r.department))].sort(),
      statuses: [...new Map(rows.map((r) => [r.status, r.statusLabel])).entries()],
      owners: [...new Set(rows.map((r) => r.owner))].sort(),
    }),
    [rows],
  );
  const active = rows.filter((r) => r.status !== "Complete" && r.status !== "Cancelled");
  const onTrack = active.filter((r) => r.status === "OnTrack").length;
  const atRisk = active.filter((r) => r.status === "AtRisk").length;
  const blocked = active.filter((r) => r.blocked || r.status === "OffTrack").length;
  const activeDepts = new Set(active.map((r) => r.department)).size;
  const shown = rows.filter((r) => {
    const t = q.trim().toLowerCase();
    if (t && !r.name.toLowerCase().includes(t) && !r.owner.toLowerCase().includes(t)) return false;
    if (dept !== "all" && r.department !== dept) return false;
    if (status !== "all" && r.status !== status) return false;
    if (owner !== "all" && r.owner !== owner) return false;
    return true;
  });
  const kpis = [
    { label: "Active projects", value: active.length, note: `Across ${activeDepts} ${activeDepts === 1 ? "department" : "departments"}` },
    { label: "On track", value: onTrack, note: `${active.length ? Math.round((onTrack / active.length) * 100) : 0}% of active` },
    { label: "At risk", value: atRisk, note: "Watch for slipping dates" },
    { label: "Blocked", value: blocked, note: "Needs owner follow-up" },
  ];
  return (
    <>
      <div>
        <h1 className={s.h1}>Service line portfolio</h1>
        <div className={s.muted} style={{ marginTop: 4 }}>
          Read-only view · updated {props.updatedLabel}
        </div>
      </div>
      <div style={{ display: "flex", gap: 12 }} data-testid="viewer-kpis">
        {kpis.map((k) => (
          <div key={k.label} className={`${s.glass} ${s.kpi}`}>
            <div className={s.muted} style={{ fontSize: 12 }}>
              {k.label}
            </div>
            <div className={s.kpiNum}>{k.value}</div>
            <div className={s.dim} style={{ fontSize: 11.5, marginTop: 2 }}>
              {k.note}
            </div>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <label className={s.search} style={{ width: 260 }}>
          <svg className={s.ic} viewBox="0 0 24 24" aria-hidden>
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input placeholder="Filter projects" aria-label="Filter projects" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <select className={s.filterSel} aria-label="Department" value={dept} onChange={(e) => setDept(e.target.value)}>
          <option value="all">Department: All</option>
          {opts.depts.map((d) => (
            <option key={d}>{d}</option>
          ))}
        </select>
        <select className={s.filterSel} aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="all">Status: All</option>
          {opts.statuses.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
        <select className={s.filterSel} aria-label="Owner" value={owner} onChange={(e) => setOwner(e.target.value)}>
          <option value="all">Owner: All</option>
          {opts.owners.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
        <span className={s.dim} style={{ marginLeft: "auto" }} data-testid="viewer-shown">
          {shown.length} of {rows.length} shown
        </span>
        <a className={`${s.btn} ${s.sm}`} style={{ height: 30 }} href={props.pdfHref} download data-testid="generate-pdf">
          <svg className={s.ic} viewBox="0 0 24 24" style={{ width: 13 }} aria-hidden>
            <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
            <path d="M14 3v6h6M12 12v6M9 15l3 3 3-3" />
          </svg>
          Generate PDF now
        </a>
      </div>
      <div className={s.glass} id="projects">
        <table className={`${s.tbl} ${s.tblCompact}`} data-testid="viewer-table">
          <thead>
            <tr>
              <th style={{ width: 300 }}>Project</th>
              <th>Department</th>
              <th>Owner</th>
              <th>Status</th>
              <th>Progress</th>
              <th>Target date</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const tone = TONES[r.status] ?? NEUTRAL;
              const pct = r.percent ?? 0;
              return (
                <tr key={r.id}>
                  <td style={{ fontWeight: 500 }}>{props.projectHrefBase ? <a href={props.projectHrefBase + encodeURIComponent(r.id)} style={{ color: "inherit", textDecoration: "none" }}>{r.name}</a> : r.name}</td>
                  <td className={s.muted}>{r.department}</td>
                  <td>{r.owner}</td>
                  <td>
                    <span className={s.pill} style={{ height: 20, fontSize: 11.5, color: tone.fg, background: tone.bg }}>
                      <span style={{ width: 6, height: 6, borderRadius: "50%", background: tone.fg }} />
                      {r.statusLabel}
                    </span>
                  </td>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div className={s.prog}>
                        <div className={s.progFill} style={{ width: `${pct}%` }} />
                      </div>
                      <span className={s.muted} style={{ fontSize: 12 }}>
                        {r.percent === null ? "Not set" : `${pct}%`}
                      </span>
                    </div>
                  </td>
                  <td className={s.muted}>{shortDate(r.target)}</td>
                </tr>
              );
            })}
            {shown.length === 0 && (
              <tr>
                <td colSpan={6} className={s.dim}>
                  No projects match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
