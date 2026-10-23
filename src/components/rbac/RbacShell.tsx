import Link from "next/link";
import type { ReactNode } from "react";
import s from "@/components/rbac/Rbac.module.css";

export type ShellNav = "dashboard" | "projects" | "reports" | "people";
export type ShellAdminLink = { id: string; label: string; href: string };

const ICONS: Record<ShellNav, ReactNode> = {
  dashboard: (
    <>
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
      <rect x="14" y="14" width="7" height="7" />
    </>
  ),
  projects: <path d="M3 7h18M3 12h18M3 17h12" />,
  reports: (
    <>
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <path d="M14 3v6h6" />
    </>
  ),
  people: (
    <>
      <circle cx="9" cy="8" r="4" />
      <path d="M2 21a7 7 0 0 1 14 0M17 11a3 3 0 1 0 0-6M22 21a6 6 0 0 0-4-5.6" />
    </>
  ),
};

const LABELS: Record<ShellNav, string> = { dashboard: "Dashboard", projects: "Projects", reports: "Reports", people: "People" };
const HREFS: Record<ShellNav, string> = { dashboard: "/", projects: "/#projects", reports: "/reports", people: "/admin/people" };

export const AVATAR_COLORS = ["#475569", "#1d4ed8", "#0e7490", "#7c3aed", "#be185d", "#b45309", "#15803d", "#9333ea", "#0f766e"];

/** A stable avatar color per email. */
export function avatarColor(key: string): string {
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

/** The Roles & Permissions app shell: sidebar (main nav, optional Admin group, signed-in person) and top bar. */
export function RbacShell(props: {
  active: ShellNav;
  nav: readonly ShellNav[];
  admin?: readonly ShellAdminLink[];
  crumb: string;
  searchPlaceholder: string;
  search?: ReactNode;
  user: { name: string; initials: string; sub: string; role: string; email: string };
  signOutAction?: () => Promise<void>;
  children: ReactNode;
}) {
  const { user } = props;
  return (
    <div className={s.root} data-testid="rbac-shell">
      <aside className={s.side}>
        <div className={s.brand}>
          <div className={s.logo}>
            <svg className={s.ic} viewBox="0 0 24 24" style={{ stroke: "#fff" }} aria-hidden>
              <path d="M3 3v18h18" />
              <path d="M7 14l4-4 3 3 5-6" />
            </svg>
          </div>
          Portfolio Tracker
        </div>
        {props.nav.map((n) => (
          <Link key={n} href={HREFS[n]} className={`${s.nav} ${props.active === n ? s.navOn : ""}`} aria-current={props.active === n ? "page" : undefined}>
            <svg className={s.ic} viewBox="0 0 24 24" aria-hidden>
              {ICONS[n]}
            </svg>
            {LABELS[n]}
          </Link>
        ))}
        {props.admin && props.admin.length > 0 && (
          <>
            <div className={s.navh}>Admin</div>
            {props.admin.map((a) => (
              <Link key={a.id} href={a.href} className={`${s.nav} ${s.sub}`}>
                {a.label}
              </Link>
            ))}
          </>
        )}
        <div className={s.foot}>
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <div className={s.av} style={{ background: avatarColor(user.email) }}>
              {user.initials}
            </div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 500 }}>{user.name}</div>
              <div className={s.dim} style={{ fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 140 }}>
                {user.sub}
              </div>
            </div>
          </div>
          <div className={s.dim} style={{ fontSize: 11, marginTop: 8, whiteSpace: "nowrap", display: "flex", gap: 6, alignItems: "center" }}>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
              Signed in as {user.name} · {user.role}
            </span>
          </div>
          {props.signOutAction && (
            <form action={props.signOutAction} style={{ marginTop: 6 }}>
              <button type="submit" className={s.linkBtn} data-testid="rbac-sign-out">
                Sign out
              </button>
            </form>
          )}
        </div>
      </aside>
      <div className={s.main}>
        <div className={s.top}>
          <div className={s.crumb}>{props.crumb}</div>
          {props.search ?? (
            <div className={s.search}>
              <svg className={s.ic} viewBox="0 0 24 24" aria-hidden>
                <circle cx="11" cy="11" r="7" />
                <path d="m21 21-4.3-4.3" />
              </svg>
              {props.searchPlaceholder}
              <span className={s.kbd}>⌘K</span>
            </div>
          )}
        </div>
        <div className={s.content}>{props.children}</div>
      </div>
    </div>
  );
}
