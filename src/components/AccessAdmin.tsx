"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { setLineAccess } from "@/app/actions/access";
import { AccountRowMenu, AddUserForm, PasswordTags, TempPasswordDialog } from "@/components/AccessAccountControls";
import { AccessGridModel } from "@/lib/access/AccessGridModel";
import { LineAccessCopy } from "@/lib/access/LineAccessCopy";
import { PasswordCopy } from "@/lib/auth/PasswordCopy";
import { AdminButtonStyles } from "@/lib/admin/AdminButtonStyles";
import type { AccessGrid, AccessLine, AccessRow } from "@/lib/services/LineAccessService";
import type { AccountResult, PasswordStatus } from "@/lib/services/UserAccountService";

const GHOST = "h-7 rounded-control border border-line px-3 text-muted type-table-strong hover:text-fg";
const PRIMARY = "h-7 rounded-control bg-accent px-3 text-white type-table-strong disabled:opacity-60";
const LINE_COL = 64;
const MENU_COL = 44;

type Confirm = { row: AccessRow; line: AccessLine } | null;

/**
 * Admin > People > Access (item 8, Figma Bro): one row per person, a short centered checkbox column per open service
 * line (short code, full name as tooltip). Every line, not just the active one. Admin rows first, locked, "All lines".
 * Each checkbox saves as you go; unchecking someone's last line asks first.
 */
export function AccessAdmin({
  grid,
  initialAdd = false,
  passwords = {},
  initialMenu = null,
}: {
  grid: AccessGrid;
  initialAdd?: boolean;
  /** Password tags and the row menu (email and password sign-in). */
  passwords?: Record<string, PasswordStatus>;
  /** Email whose ⋯ menu starts open (screenshots). */
  initialMenu?: string | null;
}) {
  const router = useRouter();
  const [users, setUsers] = useState(grid.users);
  const [adding, setAdding] = useState(initialAdd && grid.canAdd);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [temp, setTemp] = useState<{ name: string; email: string; password: string } | null>(null);
  const accountResult = (email: string) => (r: AccountResult, name: string) => {
    if (r.ok && r.temporaryPassword) setTemp({ name, email, password: r.temporaryPassword });
    else setToast(r.message);
    router.refresh();
  };
  const [, start] = useTransition();
  // A refresh brings the saved rows: adopt them (render-time sync, no effect).
  const [seen, setSeen] = useState(grid.users);
  if (seen !== grid.users) {
    setSeen(grid.users);
    setUsers(grid.users);
  }
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(t);
  }, [toast]);

  const save = (row: AccessRow, line: AccessLine, on: boolean) => {
    setUsers((list) => list.map((u) => (u.email === row.email ? AccessGridModel.toggle(u, line.id, on) : u)));
    start(async () => {
      const r = await setLineAccess(row.email, line.id, on).catch(() => ({ ok: false as const, message: LineAccessCopy.SAVE_ERROR }));
      setToast(r.ok ? r.message : LineAccessCopy.SAVE_ERROR);
      if (!r.ok) setUsers((list) => list.map((u) => (u.email === row.email ? AccessGridModel.toggle(u, line.id, !on) : u)));
      router.refresh();
    });
  };
  const change = (row: AccessRow, line: AccessLine, on: boolean) => {
    if (AccessGridModel.needsConfirm(row, line.id, on)) setConfirm({ row, line });
    else save(row, line, on);
  };

  const cols = grid.lines.length;
  return (
    <section aria-labelledby="people-access" className="flex flex-col gap-2" data-testid="people-access">
      <div className="flex items-center justify-between gap-4">
        <h2 id="people-access" className="type-heading">
          {LineAccessCopy.heading(users.length)}
        </h2>
        {grid.canAdd && (
          <button type="button" className={PRIMARY} onClick={() => setAdding(true)} disabled={adding}>
            {LineAccessCopy.ADD_USER}
          </button>
        )}
      </div>
      <p className="text-[12px] leading-4 text-(--dark-text-secondary)">{LineAccessCopy.NOTE}</p>
      {adding && (
        <AddUserForm
          lines={grid.lines}
          onCancel={() => setAdding(false)}
          onAdded={(r) => {
            setAdding(false);
            if (r.temporaryPassword) setTemp({ name: r.name ?? r.email ?? "", email: r.email ?? "", password: r.temporaryPassword });
            else setToast(r.message);
            router.refresh();
          }}
        />
      )}
      <div className="overflow-x-auto rounded-card border border-line bg-card">
        <table className="w-full table-fixed border-separate border-spacing-0 type-table" style={{ minWidth: 420 + cols * LINE_COL + MENU_COL }}>
          <colgroup>
            <col style={{ width: "34%" }} />
            <col />
            {grid.lines.map((l) => (
              <col key={l.id} style={{ width: `${LINE_COL}px` }} />
            ))}
            <col style={{ width: `${MENU_COL}px` }} />
          </colgroup>
          <thead>
            <tr className="text-left text-muted type-label uppercase">
              <th className="border-b border-line px-3 py-2">{LineAccessCopy.COLUMNS.name}</th>
              <th className="border-b border-line px-3 py-2">{LineAccessCopy.COLUMNS.email}</th>
              {grid.lines.map((l) => (
                <th key={l.id} className="border-b border-line px-1 py-2 text-center" title={l.name} data-line={l.shortName}>
                  {l.shortName}
                </th>
              ))}
              <th className="border-b border-line" aria-label={PasswordCopy.MENU_LABEL} />
            </tr>
          </thead>
          <tbody>
            {grid.admins.map((r) => (
              <tr key={r.email} data-access-row={r.email} data-admin="">
                <td className="border-b border-line px-3 py-2">
                  <span className="flex min-w-0 items-center gap-2" title={LineAccessCopy.ADMIN_LOCK_TOOLTIP}>
                    <LockIcon />
                    <span className="truncate type-table-strong">{r.name}</span>
                    <PasswordTags status={passwords[r.email]} />
                  </span>
                </td>
                <td className="truncate border-b border-line px-3 py-2 text-muted">{r.email}</td>
                {cols > 0 && (
                  <td colSpan={cols} className="border-b border-line px-3 py-2 text-center text-muted" data-testid="access-all-lines">
                    {LineAccessCopy.ALL_LINES}
                  </td>
                )}
                <td className="border-b border-line px-1 py-1 text-center">
                  <AccountRowMenu name={r.name} email={r.email} status={passwords[r.email]} initialOpen={initialMenu === r.email} onResult={accountResult(r.email)} />
                </td>
              </tr>
            ))}
            {users.map((r) => (
              <tr key={r.email} data-access-row={r.email}>
                <td className="border-b border-line px-3 py-2">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="truncate type-table-strong">{r.name}</span>
                    {AccessGridModel.hasNoAccess(r) && (
                      <span
                        className="flex-none rounded-[4px] bg-(--status-at-risk-dark-bg) px-1.5 py-px type-label font-semibold text-(--status-at-risk-dark-fg)"
                        title={LineAccessCopy.NO_ACCESS_TOOLTIP}
                        data-testid="access-no-access"
                      >
                        {LineAccessCopy.NO_ACCESS_TAG}
                      </span>
                    )}
                    <PasswordTags status={passwords[r.email]} />
                  </span>
                </td>
                <td className="truncate border-b border-line px-3 py-2 text-muted">{r.email}</td>
                {grid.lines.map((l) => {
                  const on = r.lineIds.includes(l.id);
                  return (
                    <td key={l.id} className="border-b border-line px-1 py-2 text-center">
                      <input
                        type="checkbox"
                        className="size-4 cursor-pointer accent-accent align-middle"
                        checked={on}
                        aria-label={LineAccessCopy.checkboxLabel(r.name, l.shortName)}
                        onChange={(e) => change(r, l, e.target.checked)}
                      />
                    </td>
                  );
                })}
                <td className="border-b border-line px-1 py-1 text-center">
                  <AccountRowMenu name={r.name} email={r.email} status={passwords[r.email]} initialOpen={initialMenu === r.email} onResult={accountResult(r.email)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {users.length === 0 && (
          <div className="px-4 py-4 text-center text-muted type-table" data-testid="access-empty">
            {LineAccessCopy.EMPTY}
          </div>
        )}
      </div>

      {confirm && (
        <ConfirmLastLine
          name={confirm.row.name}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const { row, line } = confirm;
            setConfirm(null);
            save(row, line, false);
          }}
        />
      )}
      {temp && <TempPasswordDialog name={temp.name} email={temp.email} password={temp.password} onDone={() => setTemp(null)} />}
      {toast && (
        <div role="status" data-testid="access-toast" className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-4 rounded-card border border-line bg-(--dark-input) px-4 py-2.5 text-fg shadow-lg type-table">
          {toast}
        </div>
      )}
    </section>
  );
}

function LockIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-label={LineAccessCopy.ADMIN_LOCK_TOOLTIP} role="img" className="flex-none text-muted" data-testid="access-lock">
      <rect x="2.5" y="5.5" width="7" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <path d="M4 5.5V4a2 2 0 0 1 4 0v1.5" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function ConfirmLastLine({ name, onCancel, onConfirm }: { name: string; onCancel: () => void; onConfirm: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  return (
    <div className="sl-scrim" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div role="alertdialog" aria-modal="true" aria-labelledby="access-last-title" aria-describedby="access-last-body" className="flex w-[440px] flex-col gap-3 rounded-card border border-line bg-card px-5 py-4 shadow-[0_12px_32px_rgba(0,0,0,.45)]">
        <h2 id="access-last-title" className="type-heading">
          {LineAccessCopy.removeLastTitle(name)}
        </h2>
        <p id="access-last-body" className="type-table text-muted">
          {LineAccessCopy.REMOVE_LAST_BODY}
        </p>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} className={GHOST}>
            {LineAccessCopy.CANCEL}
          </button>
          <button type="button" autoFocus className={AdminButtonStyles.DANGER} onClick={onConfirm}>
            {LineAccessCopy.REMOVE_LAST_BUTTON}
          </button>
        </div>
      </div>
    </div>
  );
}
