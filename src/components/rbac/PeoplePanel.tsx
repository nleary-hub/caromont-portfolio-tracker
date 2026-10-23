"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import s from "@/components/rbac/Rbac.module.css";
import { avatarColor } from "@/components/rbac/RbacShell";
import type { RoleOption } from "@/lib/people/RoleAssignment";
import type { PeopleResult, PersonRow } from "@/lib/services/PeopleRoleService";

type Actions = {
  assign: (email: string, roleId: string) => Promise<PeopleResult>;
  invite: (input: { email: string; name: string; roleId: string }) => Promise<PeopleResult>;
  revoke: (email: string) => Promise<PeopleResult>;
};

const HINT = "You can assign roles below your own";
const PAGE = 10;

const Chevron = () => (
  <svg className={s.ic} viewBox="0 0 24 24" style={{ width: 13, color: "#7d8596" }} aria-hidden>
    <path d="m6 9 6 6 6-6" />
  </svg>
);
const Check = () => (
  <svg className={s.ic} viewBox="0 0 24 24" style={{ width: 13 }} aria-hidden>
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

/** "Just now", "5 min ago", "1 hr ago", "Yesterday", or "Oct 9". */
export function relativeTime(iso: string | null, now: Date): string {
  if (!iso) return "";
  const d = new Date(iso);
  const mins = Math.floor((now.getTime() - d.getTime()) / 60000);
  if (mins < 2) return "Just now";
  if (mins < 60) return `${mins} min ago`;
  if (mins < 24 * 60) return `${Math.floor(mins / 60)} hr ago`;
  if (mins < 48 * 60) return "Yesterday";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });
}

function RoleMenu(props: { roles: readonly RoleOption[]; value: string; onPick: (id: string) => void; wide?: boolean; testId: string }) {
  return (
    <div className={s.menu} role="listbox" data-testid={props.testId} style={props.wide ? { marginTop: 4 } : { position: "absolute", top: 30, left: 0, width: 220, zIndex: 10 }}>
      {props.roles.map((r) => (
        <button
          type="button"
          key={r.id}
          role="option"
          aria-selected={r.id === props.value}
          className={`${s.mi} ${r.id === props.value ? s.miHl : ""}`}
          style={props.wide ? undefined : { height: 40 }}
          onClick={() => props.onPick(r.id)}
        >
          <span style={{ width: 14 }}>{r.id === props.value ? <Check /> : null}</span>
          {props.wide ? (
            <>
              {r.name}
              <span className={s.dim} style={{ marginLeft: "auto", fontSize: 11 }}>
                {r.description}
              </span>
            </>
          ) : (
            <div>
              <div style={{ fontSize: 12.5 }}>{r.name}</div>
              <div className={s.dim} style={{ fontSize: 11 }}>
                {r.description}
              </div>
            </div>
          )}
        </button>
      ))}
      <div className={s.menuHint}>{HINT}</div>
    </div>
  );
}

function InviteDialog(props: { roles: readonly RoleOption[]; onClose: () => void; invite: Actions["invite"]; done: (r: PeopleResult) => void; initialRoleOpen?: boolean }) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const viewer = props.roles.find((r) => r.id === "viewer") ?? props.roles[props.roles.length - 1];
  const [roleId, setRoleId] = useState(viewer?.id ?? "");
  const [open, setOpen] = useState(Boolean(props.initialRoleOpen));
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const role = props.roles.find((r) => r.id === roleId);
  const submit = () =>
    start(async () => {
      const r = await props.invite({ email, name, roleId });
      if (r.ok) props.done(r);
      else setError(r.message);
    });
  return (
    <div className={s.overlay} onClick={props.onClose}>
      <div className={s.dialog} role="dialog" aria-modal="true" aria-labelledby="invite-title" data-testid="invite-dialog" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <div>
            <div id="invite-title" style={{ fontSize: 15, fontWeight: 600 }}>
              Invite user
            </div>
            <div className={s.muted} style={{ marginTop: 4 }}>
              Shows as Pending until they first sign in.
            </div>
          </div>
          <button type="button" className={s.iconbtn} aria-label="Close" onClick={props.onClose}>
            <svg className={s.ic} viewBox="0 0 24 24" aria-hidden>
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 12 }}>
            <div>
              <label className={s.label} htmlFor="invite-email">
                Email
              </label>
              <input id="invite-email" className={s.input} type="email" required autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} data-testid="invite-email" />
            </div>
            <div>
              <label className={s.label} htmlFor="invite-name">
                Full name
              </label>
              <input id="invite-name" className={s.input} autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} data-testid="invite-name" />
            </div>
            <div>
              <span className={s.label}>Role</span>
              <button type="button" className={`${s.select} ${open ? s.selectFocus : ""}`} aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen((o) => !o)} data-testid="invite-role">
                <span>{role?.name ?? "Choose a role"}</span>
                <Chevron />
              </button>
              {open && (
                <RoleMenu
                  wide
                  testId="invite-role-menu"
                  roles={props.roles}
                  value={roleId}
                  onPick={(id) => {
                    setRoleId(id);
                    setOpen(false);
                  }}
                />
              )}
            </div>
            <div className={s.dim} style={{ fontSize: 11.5 }}>
              AI cap: $10.00 / month (example figure, set by the owner)
            </div>
            {error && (
              <div role="alert" style={{ color: "#fca5a5", fontSize: 12 }} data-testid="invite-error">
                {error}
              </div>
            )}
          </div>
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
            <button type="button" className={s.btn} onClick={props.onClose}>
              Cancel
            </button>
            <button type="submit" className={`${s.btn} ${s.pri}`} disabled={pending || !roleId} data-testid="invite-submit">
              Send invite
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** People: the role picker per person, pending invites, filters and Invite user. Every change is checked on the server. */
export function PeoplePanel(props: {
  people: PersonRow[];
  assignable: RoleOption[];
  roles: RoleOption[];
  canInvite: boolean;
  departmentCount: number;
  nowIso: string;
  actions: Actions;
  initialInvite?: boolean;
  initialRoleOpen?: boolean;
  initialPicker?: string | null;
}) {
  const router = useRouter();
  const now = useMemo(() => new Date(props.nowIso), [props.nowIso]);
  const [q, setQ] = useState("");
  const [dept, setDept] = useState("all");
  const [roleFilter, setRoleFilter] = useState("all");
  const [page, setPage] = useState(0);
  const [picker, setPicker] = useState<string | null>(props.initialPicker ?? null);
  const [inviting, setInviting] = useState(Boolean(props.initialInvite));
  const [toast, setToast] = useState<PeopleResult | null>(null);
  const [, start] = useTransition();

  const departments = useMemo(() => [...new Set(props.people.map((p) => p.department))].sort(), [props.people]);
  const filtered = props.people.filter((p) => {
    const t = q.trim().toLowerCase();
    if (t && !p.name.toLowerCase().includes(t) && !p.email.includes(t)) return false;
    if (dept !== "all" && p.department !== dept) return false;
    if (roleFilter !== "all" && p.roleId !== roleFilter) return false;
    return true;
  });
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const current = Math.min(page, pages - 1);
  const shown = filtered.slice(current * PAGE, current * PAGE + PAGE);
  const pendingCount = props.people.filter((p) => p.pending).length;
  const signedIn = props.people.length - pendingCount;

  const report = (r: PeopleResult) => {
    setToast(r);
    if (r.ok) router.refresh();
    setTimeout(() => setToast(null), 5000);
  };
  const assign = (email: string, roleId: string) =>
    start(async () => {
      setPicker(null);
      report(await props.actions.assign(email, roleId));
    });
  const revoke = (email: string) =>
    start(async () => {
      report(await props.actions.revoke(email));
    });
  const copyLink = async () => {
    const link = `${window.location.origin}/signin`;
    try {
      await navigator.clipboard.writeText(link);
      report({ ok: true, message: "Sign-in link copied. No email is sent; share it with them yourself." });
    } catch {
      report({ ok: true, message: `No email is sent. Share the sign-in link yourself: ${link}` });
    }
  };

  return (
    <>
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
        <div>
          <h1 className={s.h1}>People</h1>
          <div className={s.muted} style={{ marginTop: 4 }} data-testid="people-summary">
            {signedIn} {signedIn === 1 ? "user" : "users"} across {props.departmentCount} {props.departmentCount === 1 ? "department" : "departments"}
            {pendingCount ? ` · ${pendingCount} pending ${pendingCount === 1 ? "invite" : "invites"}` : ""}. AI usage figures are examples.
          </div>
        </div>
        {props.canInvite && (
          <button type="button" className={`${s.btn} ${s.pri}`} onClick={() => setInviting(true)} data-testid="invite-open">
            <svg className={s.ic} viewBox="0 0 24 24" style={{ width: 13 }} aria-hidden>
              <path d="M12 5v14M5 12h14" />
            </svg>
            Invite user
          </button>
        )}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <label className={s.search} style={{ width: 280 }}>
          <svg className={s.ic} viewBox="0 0 24 24" aria-hidden>
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            placeholder="Filter by name or email"
            aria-label="Filter by name or email"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(0);
            }}
          />
        </label>
        <select className={s.filterSel} aria-label="Department" value={dept} onChange={(e) => { setDept(e.target.value); setPage(0); }}>
          <option value="all">Department: All</option>
          {departments.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        <select className={s.filterSel} aria-label="Role" value={roleFilter} onChange={(e) => { setRoleFilter(e.target.value); setPage(0); }}>
          <option value="all">Role: All</option>
          <option value="owner">Owner</option>
          {props.roles.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </div>
      <div className={s.glass}>
        <table className={s.tbl} data-testid="people-table">
          <thead>
            <tr>
              <th style={{ width: 250 }}>Name</th>
              <th>Email</th>
              <th>Department</th>
              <th>Joined</th>
              <th style={{ width: 190 }}>AI usage</th>
              <th style={{ width: 270 }}>Role</th>
              <th style={{ width: 44 }} />
            </tr>
          </thead>
          <tbody>
            {shown.map((p) => {
              const pct = Math.min(100, Math.round((p.aiCostUsd / 10) * 100));
              return (
                <tr key={p.email} className={p.pending ? s.pendingRow : undefined} data-testid={`person-${p.email}`}>
                  <td>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <div className={`${s.av} ${p.pending ? s.avPending : ""}`} style={{ background: avatarColor(p.email) }}>
                        {p.initials}
                      </div>
                      <span style={{ fontWeight: 500, color: p.pending ? "#b7bcc7" : undefined }}>
                        {p.name}
                        {p.you && (
                          <span className={s.dim} style={{ fontWeight: 400 }}>
                            {" "}
                            (you)
                          </span>
                        )}
                      </span>
                      {p.pending && <span className={`${s.pill} ${s.pendingPill}`}>Pending</span>}
                    </div>
                  </td>
                  <td className={s.muted}>{p.email}</td>
                  <td className={p.pending ? s.muted : undefined} title={p.department} style={{ maxWidth: 190, overflow: "hidden", textOverflow: "ellipsis" }}>{p.department}</td>
                  <td className={s.muted}>{p.pending ? `Sent ${new Date(p.invitedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" })}` : relativeTime(p.firstSignInAt, now) || "Not yet"}</td>
                  <td>
                    {p.owner ? (
                      <span className={s.dim}>No cap</span>
                    ) : p.pending ? (
                      <span className={s.dim}>Not yet</span>
                    ) : (
                      <div style={{ width: 150 }}>
                        <div style={{ fontSize: 12 }}>
                          <span style={{ fontWeight: 500 }}>${p.aiCostUsd.toFixed(2)}</span> <span className={s.dim}>of $10.00 this month</span>
                        </div>
                        <div className={s.bar}>
                          <div className={`${s.barFill} ${pct >= 85 ? s.barWarn : ""}`} style={{ width: `${Math.max(pct, 2)}%` }} />
                        </div>
                      </div>
                    )}
                  </td>
                  <td>
                    {p.owner ? (
                      <div style={{ display: "flex", alignItems: "center" }} data-testid="owner-locked">
                        <span className={`${s.pill} ${s.ownerPill}`}>
                          <svg className={s.ic} viewBox="0 0 24 24" style={{ width: 12, height: 12 }} aria-hidden>
                            <rect x="4" y="11" width="16" height="10" rx="2" />
                            <path d="M8 11V7a4 4 0 0 1 8 0v4" />
                          </svg>
                          Owner
                        </span>
                        <span className={`${s.menu} ${s.lockNote}`}>Locked · not assignable</span>
                      </div>
                    ) : p.pending ? (
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span className={s.muted} style={{ fontSize: 12.5, width: 56 }}>
                          {p.roleName}
                        </span>
                        {p.canRevoke && (
                          <>
                            <button type="button" className={`${s.btn} ${s.sm}`} onClick={copyLink} title="Copies the sign-in link. No email is sent.">
                              Resend
                            </button>
                            <button type="button" className={`${s.btn} ${s.sm} ${s.danger}`} onClick={() => revoke(p.email)} data-testid={`revoke-${p.email}`}>
                              Revoke
                            </button>
                          </>
                        )}
                      </div>
                    ) : p.canChange && props.assignable.length ? (
                      <div style={{ position: "relative", display: "inline-block" }}>
                        <button
                          type="button"
                          className={`${s.select} ${s.selectSm} ${picker === p.email ? s.selectFocus : ""}`}
                          aria-haspopup="listbox"
                          aria-expanded={picker === p.email}
                          aria-label={`Role for ${p.name}`}
                          onClick={() => setPicker(picker === p.email ? null : p.email)}
                          data-testid={`role-${p.email}`}
                        >
                          <span>{p.roleName}</span>
                          <Chevron />
                        </button>
                        {picker === p.email && <RoleMenu roles={props.assignable} value={p.roleId} onPick={(id) => assign(p.email, id)} testId="role-menu" />}
                      </div>
                    ) : (
                      <span style={{ paddingLeft: 9, fontSize: 12.5 }} data-testid={`role-text-${p.email}`}>
                        {p.roleName}
                      </span>
                    )}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    {!p.pending && (
                      <Link href={`/admin/people/access?access=${encodeURIComponent(p.email)}`} className={s.iconbtn} aria-label={`Line access for ${p.name}`} title="Line access and account">
                        <svg className={s.ic} viewBox="0 0 24 24" aria-hidden>
                          <circle cx="5" cy="12" r="1" />
                          <circle cx="12" cy="12" r="1" />
                          <circle cx="19" cy="12" r="1" />
                        </svg>
                      </Link>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className={`${s.pager} ${s.dim}`}>
          <span>
            Showing {filtered.length ? current * PAGE + 1 : 0}–{current * PAGE + shown.length} of {filtered.length}
          </span>
          <span style={{ display: "flex", gap: 6 }}>
            <button type="button" className={`${s.btn} ${s.sm}`} disabled={current === 0} onClick={() => setPage(current - 1)}>
              Previous
            </button>
            <button type="button" className={`${s.btn} ${s.sm}`} disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>
              Next
            </button>
          </span>
        </div>
      </div>
      {inviting && (
        <InviteDialog
          roles={props.assignable}
          initialRoleOpen={props.initialRoleOpen}
          invite={props.actions.invite}
          onClose={() => setInviting(false)}
          done={(r) => {
            setInviting(false);
            report(r);
          }}
        />
      )}
      {toast && (
        <div className={`${s.menu} ${s.toast} ${toast.ok ? "" : s.toastErr}`} role="status" data-testid="people-toast">
          {toast.message}
        </div>
      )}
    </>
  );
}
