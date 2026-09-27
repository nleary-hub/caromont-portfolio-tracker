"use client";

import { useRouter } from "next/navigation";
import { Fragment, useEffect, useState, useTransition } from "react";
import { setAllDepartments, setDepartmentAccess, setLineAccess } from "@/app/actions/access";
import { AccountRowMenu, PasswordTags, TempPasswordDialog } from "@/components/AccessAccountControls";
import { AddUserWithDepartments } from "@/components/AddUserDepartments";
import { AccessGridModel } from "@/lib/access/AccessGridModel";
import { DepartmentAccessCopy } from "@/lib/access/DepartmentAccessCopy";
import { LineAccessCopy } from "@/lib/access/LineAccessCopy";
import { PasswordCopy } from "@/lib/auth/PasswordCopy";
import { AdminButtonStyles } from "@/lib/admin/AdminButtonStyles";
import type { AccessDepartment, AccessGrid, AccessLine, AccessRow } from "@/lib/services/LineAccessService";
import type { AccountResult, PasswordStatus } from "@/lib/services/UserAccountService";

const GHOST = "h-7 rounded-control border border-line px-3 text-muted type-table-strong hover:text-fg";
const PRIMARY = "h-7 rounded-control bg-accent px-3 text-white type-table-strong disabled:opacity-60";
const LINE_COL = 64;
/** The last column: the department caret and the ⋯ account menu. */
const ACTION_COL = 72;

type Confirm = { row: AccessRow; line: AccessLine; department?: AccessDepartment } | null;
type Result = { ok: boolean; message: string };

/**
 * Admin > People > Access (item 8, Figma Bro): one row per person, a short centered checkbox column per open service
 * line (short code, full name as tooltip). Every line, not just the active one. Admin rows first, locked, "All lines".
 * Each checkbox saves as you go; unchecking someone's last line asks first.
 *
 * Department access (follow-up, Figma Bro): a checked line covers All departments by default. A line limited to
 * some departments shows "3 of 7" in small gray text under its checkbox. Clicking the name, or the caret at the end
 * of the row, opens a panel under the row with one block per line the person has: an "All departments" switch and,
 * when it's off, the line's departments as checkboxes (A to Z). One panel at a time; Esc or the name closes it.
 */
export function AccessAdmin({
  grid,
  initialAdd = false,
  initialExpanded = null,
  passwords = {},
  initialMenu = null,
  viewerEmail = null,
}: {
  grid: AccessGrid;
  initialAdd?: boolean;
  initialExpanded?: string | null;
  /** Password tags and the row menu (email and password sign-in). */
  passwords?: Record<string, PasswordStatus>;
  /** Email whose ⋯ menu starts open (screenshots). */
  initialMenu?: string | null;
  /** The signed-in admin (lowercase): their own row has no Turn off sign-in. */
  viewerEmail?: string | null;
}) {
  const router = useRouter();
  const [users, setUsers] = useState(grid.users);
  const [adding, setAdding] = useState(initialAdd && grid.canAdd);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [expanded, setExpanded] = useState<string | null>(initialExpanded);
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

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !confirm && setExpanded(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded, confirm]);

  // Optimistic: apply `next` to the row now; on failure put the row back as it was. The refresh brings the saved rows.
  const persist = (row: AccessRow, next: (u: AccessRow) => AccessRow, call: () => Promise<Result>) => {
    const before = users.find((u) => u.email === row.email) ?? row;
    setUsers((list) => list.map((u) => (u.email === row.email ? next(u) : u)));
    start(async () => {
      const r = await call().catch(() => ({ ok: false, message: LineAccessCopy.SAVE_ERROR }));
      setToast(r.ok ? r.message : LineAccessCopy.SAVE_ERROR);
      if (!r.ok) setUsers((list) => list.map((u) => (u.email === row.email ? before : u)));
      router.refresh();
    });
  };
  const save = (row: AccessRow, line: AccessLine, on: boolean) =>
    persist(row, (u) => AccessGridModel.toggle(u, line.id, on), () => setLineAccess(row.email, line.id, on));
  const change = (row: AccessRow, line: AccessLine, on: boolean) => {
    if (AccessGridModel.needsConfirm(row, line.id, on)) setConfirm({ row, line });
    else save(row, line, on);
  };
  const saveAll = (row: AccessRow, line: AccessLine, on: boolean) =>
    persist(row, (u) => AccessGridModel.setAll(u, line, on), () => setAllDepartments(row.email, line.id, on));
  const saveDepartment = (row: AccessRow, line: AccessLine, d: AccessDepartment, on: boolean) =>
    persist(row, (u) => AccessGridModel.toggleDepartment(u, line.id, d.id, on), () => setDepartmentAccess(row.email, line.id, d.id, on));
  const changeDepartment = (row: AccessRow, line: AccessLine, d: AccessDepartment, on: boolean) => {
    if (AccessGridModel.needsDepartmentConfirm(row, line.id, d.id, on)) setConfirm({ row, line, department: d });
    else saveDepartment(row, line, d, on);
  };
  const toggleExpanded = (email: string) => setExpanded((cur) => (cur === email ? null : email));

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
        <AddUserWithDepartments
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
        <table className="w-full table-fixed border-separate border-spacing-0 type-table" style={{ minWidth: 420 + cols * LINE_COL + ACTION_COL }}>
          <colgroup>
            <col style={{ width: "34%" }} />
            <col />
            {grid.lines.map((l) => (
              <col key={l.id} style={{ width: `${LINE_COL}px` }} />
            ))}
            <col style={{ width: `${ACTION_COL}px` }} />
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
                  <AccountRowMenu name={r.name} email={r.email} status={passwords[r.email]} isSelf={viewerEmail === r.email.toLowerCase()} initialOpen={initialMenu === r.email} onResult={accountResult(r.email)} />
                </td>
              </tr>
            ))}
            {users.map((r) => {
              const canExpand = AccessGridModel.expandable(r);
              const open = canExpand && expanded === r.email;
              const panelId = `access-panel-${r.email}`;
              return (
                <Fragment key={r.email}>
                  <tr data-access-row={r.email} data-expanded={open ? "" : undefined} className={open ? "bg-row-selected" : undefined}>
                    <td className={`${open ? "" : "border-b"} border-line px-3 py-2`}>
                      <span className="flex min-w-0 items-center gap-2">
                        {canExpand ? (
                          <button
                            type="button"
                            className="truncate text-left type-table-strong hover:text-accent"
                            aria-expanded={open}
                            aria-controls={open ? panelId : undefined}
                            onClick={() => toggleExpanded(r.email)}
                            data-testid="access-name"
                          >
                            {r.name}
                          </button>
                        ) : (
                          <span className="truncate type-table-strong">{r.name}</span>
                        )}
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
                    <td className={`truncate ${open ? "" : "border-b"} border-line px-3 py-2 text-muted`}>{r.email}</td>
                    {grid.lines.map((l) => {
                      const on = r.lineIds.includes(l.id);
                      const count = AccessGridModel.count(r, l);
                      return (
                        <td key={l.id} className={`${open ? "" : "border-b"} border-line px-1 py-2 text-center align-middle`}>
                          <span className="inline-flex flex-col items-center">
                            <input
                              type="checkbox"
                              className="size-4 cursor-pointer accent-accent align-middle"
                              checked={on}
                              aria-label={count ? DepartmentAccessCopy.limitedCellLabel(r.name, l.shortName, count.granted, count.total) : LineAccessCopy.checkboxLabel(r.name, l.shortName)}
                              onChange={(e) => change(r, l, e.target.checked)}
                            />
                            {count && (
                              <span className="mt-0.5 text-[11px] leading-3 text-muted" aria-hidden="true" data-testid="access-count">
                                {DepartmentAccessCopy.countText(count.granted, count.total)}
                              </span>
                            )}
                          </span>
                        </td>
                      );
                    })}
                    <td className={`${open ? "" : "border-b"} border-line pr-1 text-right`}>
                      <span className="inline-flex items-center justify-end gap-0.5">
                        {canExpand && (
                          <button
                            type="button"
                            className="inline-flex size-6 items-center justify-center rounded-control text-muted hover:bg-input hover:text-fg"
                            aria-expanded={open}
                            aria-controls={open ? panelId : undefined}
                            aria-label={open ? DepartmentAccessCopy.hideDepartments(r.name) : DepartmentAccessCopy.showDepartments(r.name)}
                            title={open ? DepartmentAccessCopy.hideDepartments(r.name) : DepartmentAccessCopy.showDepartments(r.name)}
                            onClick={() => toggleExpanded(r.email)}
                            data-testid="access-caret"
                          >
                            <CaretIcon open={open} />
                          </button>
                        )}
                        <AccountRowMenu name={r.name} email={r.email} status={passwords[r.email]} isSelf={viewerEmail === r.email.toLowerCase()} initialOpen={initialMenu === r.email} onResult={accountResult(r.email)} />
                      </span>
                    </td>
                  </tr>
                  {open && (
                    <tr data-access-panel-row={r.email}>
                      <td colSpan={cols + 3} className="border-b border-line p-0">
                        <DepartmentPanel
                          id={panelId}
                          row={r}
                          lines={grid.lines.filter((l) => r.lineIds.includes(l.id))}
                          onAll={(l, on) => saveAll(r, l, on)}
                          onDepartment={(l, d, on) => changeDepartment(r, l, d, on)}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
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
          title={confirm.department ? DepartmentAccessCopy.removeLastTitle(confirm.row.name, confirm.line.shortName) : LineAccessCopy.removeLastTitle(confirm.row.name)}
          body={confirm.department && confirm.row.lineIds.length > 1 ? DepartmentAccessCopy.removeLastBody(confirm.line.shortName) : LineAccessCopy.REMOVE_LAST_BODY}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const { row, line, department } = confirm;
            setConfirm(null);
            if (department) saveDepartment(row, line, department, false);
            else save(row, line, false);
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

function ConfirmLastLine({ title, body, onCancel, onConfirm }: { title: string; body: string; onCancel: () => void; onConfirm: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  return (
    <div className="sl-scrim" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div role="alertdialog" aria-modal="true" aria-labelledby="access-last-title" aria-describedby="access-last-body" className="flex w-[440px] flex-col gap-3 rounded-card border border-line bg-card px-5 py-4 shadow-[0_12px_32px_rgba(0,0,0,.45)]">
        <h2 id="access-last-title" className="type-heading">
          {title}
        </h2>
        <p id="access-last-body" className="type-table text-muted">
          {body}
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

function CaretIcon({ open }: { open: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" className={`transition-transform ${open ? "rotate-180" : ""}`}>
      <path d="M3 4.5 6 7.5 9 4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * The expanded panel under a person's row: indented, on the subtle panel background, 12px padding, one block per
 * line they have (short code and full name, the All departments switch, and the department checkboxes when it's off).
 */
function DepartmentPanel({
  id,
  row,
  lines,
  onAll,
  onDepartment,
}: {
  id: string;
  row: AccessRow;
  lines: AccessLine[];
  onAll: (line: AccessLine, on: boolean) => void;
  onDepartment: (line: AccessLine, d: AccessDepartment, on: boolean) => void;
}) {
  return (
    <div id={id} className="ml-6 flex flex-col gap-3 border-l border-line bg-bg p-3" data-testid="access-panel">
      {lines.map((l) => {
        const all = AccessGridModel.isAll(row, l.id);
        const helpId = `${id}-${l.id}-help`;
        return (
          <section key={l.id} className="flex flex-col gap-2" aria-label={`${l.shortName} ${l.name}`} data-panel-line={l.shortName}>
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="type-table-strong">{l.shortName}</span>
              <span className="text-muted type-table">{l.name}</span>
            </div>
            <div className="flex items-center gap-2.5">
              <button
                type="button"
                role="switch"
                aria-checked={all}
                aria-describedby={helpId}
                onClick={() => onAll(l, !all)}
                className={`relative inline-flex h-4 w-7 flex-none items-center rounded-full transition-colors ${all ? "bg-accent" : "bg-line"}`}
                data-testid="access-all-switch"
              >
                <span className={`inline-block size-3 rounded-full bg-white transition-transform ${all ? "translate-x-3.5" : "translate-x-0.5"}`} />
                <span className="sr-only">{DepartmentAccessCopy.ALL_DEPARTMENTS}</span>
              </button>
              <span className="type-table" aria-hidden="true">
                {DepartmentAccessCopy.ALL_DEPARTMENTS}
              </span>
              <span id={helpId} className="text-muted type-caption">
                {all ? DepartmentAccessCopy.HELPER_ON : DepartmentAccessCopy.HELPER_OFF}
              </span>
            </div>
            {!all && (
              <div className="grid gap-x-4 gap-y-1.5 pl-9" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))" }} data-testid="access-departments">
                {l.departments.map((d) => (
                  <label key={d.id} className="flex min-w-0 items-center gap-2 type-table">
                    <input
                      type="checkbox"
                      className="size-4 flex-none cursor-pointer accent-accent"
                      checked={AccessGridModel.hasDepartment(row, l.id, d.id)}
                      aria-label={DepartmentAccessCopy.departmentCheckbox(row.name, d.name, l.shortName)}
                      onChange={(e) => onDepartment(l, d, e.target.checked)}
                    />
                    <span className="truncate">{d.name}</span>
                  </label>
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
