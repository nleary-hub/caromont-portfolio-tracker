"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { addUserAccount, resetUserPassword, setPasswordSignIn, unlockUser } from "@/app/actions/accounts";
import { usePopover } from "@/components/DashboardFilterControls";
import { LineAccessCopy } from "@/lib/access/LineAccessCopy";
import { PasswordCopy } from "@/lib/auth/PasswordCopy";
import type { AccessLine } from "@/lib/services/LineAccessService";
import type { AccountResult, PasswordStatus } from "@/lib/services/UserAccountService";

const GHOST = "h-7 rounded-control border border-line px-3 text-muted type-table-strong hover:text-fg";
const PRIMARY = "h-7 rounded-control bg-accent px-3 text-white type-table-strong disabled:opacity-60";
const INPUT = "h-8 w-full min-w-0 rounded-control border border-line bg-input px-2.5 text-fg type-table focus:border-accent focus:outline-none";
const TAG = "flex-none rounded-[4px] px-1.5 py-px type-label font-semibold";

/** Password tags after a person's name in the Access grid: Password, Must change password, Off, and Locked. */
export function PasswordTags({ status }: { status?: PasswordStatus }) {
  if (!status) return null;
  const tags: Array<{ label: string; tip: string; cls: string; id: string }> = [];
  // Every row says how the person signs in: Google (no password), Password, Must change password or Off.
  const PASSWORD_CLS = "bg-(--status-on-hold-dark-bg) text-(--status-on-hold-dark-fg)";
  if (status.state === "none") tags.push({ id: "google", label: PasswordCopy.TAG_GOOGLE, tip: PasswordCopy.TAG_GOOGLE_TIP, cls: PASSWORD_CLS });
  if (status.state === "active") tags.push({ id: "password", label: PasswordCopy.TAG_PASSWORD, tip: PasswordCopy.TAG_PASSWORD_TIP, cls: PASSWORD_CLS });
  if (status.state === "mustChange") tags.push({ id: "must-change", label: PasswordCopy.TAG_MUST_CHANGE, tip: PasswordCopy.TAG_MUST_CHANGE_TIP, cls: "bg-(--flag-changed-dark-bg) text-(--flag-changed-dark-fg)" });
  if (status.state === "off") tags.push({ id: "off", label: PasswordCopy.TAG_OFF, tip: PasswordCopy.TAG_OFF_TIP, cls: "bg-(--status-cancelled-dark-bg) text-(--status-cancelled-dark-fg)" });
  if (status.locked) tags.push({ id: "locked", label: PasswordCopy.TAG_LOCKED, tip: PasswordCopy.TAG_LOCKED_TIP, cls: "bg-(--status-at-risk-dark-bg) text-(--status-at-risk-dark-fg)" });
  return (
    <>
      {tags.map((t) => (
        <span key={t.id} className={`${TAG} ${t.cls}`} title={t.tip} data-password-tag={t.id}>
          {t.label}
        </span>
      ))}
    </>
  );
}

/** The row's ⋯ menu: create or reset a temporary password, unlock, turn password sign-in off or on. */
export function AccountRowMenu({
  name,
  email,
  status,
  initialOpen = false,
  onResult,
}: {
  name: string;
  email: string;
  status?: PasswordStatus;
  initialOpen?: boolean;
  onResult: (r: AccountResult, name: string) => void;
}) {
  const { open, setOpen, rootRef } = usePopover();
  const [, start] = useTransition();
  // Fixed position from the button, so the grid's scroll container never clips the menu.
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const place = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 4, right: window.innerWidth - r.right });
  };
  useEffect(() => {
    if (!open) return;
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);
  const [opened, setOpened] = useState(false);
  if (initialOpen && !opened) {
    setOpened(true);
    setOpen(true);
  }
  const run = (work: () => Promise<AccountResult>) => {
    setOpen(false);
    start(async () => onResult(await work().catch(() => ({ ok: false as const, message: PasswordCopy.SAVE_ERROR })), name));
  };
  const state = status?.state ?? "none";
  const items: Array<{ label: string; act: () => Promise<AccountResult>; danger?: boolean }> = [
    { label: state === "none" ? PasswordCopy.MENU_CREATE : PasswordCopy.MENU_RESET, act: () => resetUserPassword(email) },
  ];
  if (status?.locked) items.push({ label: PasswordCopy.MENU_UNLOCK, act: () => unlockUser(email) });
  if (state === "off") items.push({ label: PasswordCopy.MENU_TURN_ON, act: () => setPasswordSignIn(email, true) });
  else if (state !== "none") items.push({ label: PasswordCopy.MENU_TURN_OFF, act: () => setPasswordSignIn(email, false), danger: true });
  return (
    <div ref={rootRef} className="relative inline-block">
      <button ref={btnRef} type="button" className="df-icon-btn" aria-haspopup="menu" aria-expanded={open} aria-label={`${PasswordCopy.MENU_LABEL} for ${name}`} onClick={() => setOpen(!open)} data-testid="access-row-menu">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
          <circle cx="3" cy="7" r="1.3" />
          <circle cx="7" cy="7" r="1.3" />
          <circle cx="11" cy="7" r="1.3" />
        </svg>
      </button>
      {open && (
        <ul role="menu" className="vp-pop vp-list w-[210px] p-1 text-left" style={pos ? { position: "fixed", top: pos.top, right: pos.right, left: "auto", zIndex: 60 } : { visibility: "hidden" }}>
          {items.map((i) => (
            <li
              key={i.label}
              role="menuitem"
              tabIndex={0}
              className={`cursor-pointer ${i.danger ? "text-danger" : ""}`}
              onClick={() => run(i.act)}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && run(i.act)}
            >
              {i.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Add user: email, optional name, the service lines they may see and an optional temporary password, saved together.
 * `lineExtra` renders per-line extras under each line (the department switch and checkboxes, AddUserDepartments); it
 * can uncheck its line. `extraInput` goes to the same save (the chosen departments), where an AddUserGrantHook
 * stores it in the same transaction.
 */
export function AddUserForm({
  lines,
  onCancel,
  onAdded,
  lineExtra,
  extraInput,
}: {
  lines: AccessLine[];
  onCancel: () => void;
  onAdded: (r: Extract<AccountResult, { ok: true }>) => void;
  lineExtra?: (line: AccessLine, checked: boolean, setChecked: (on: boolean) => void) => React.ReactNode;
  extraInput?: { departments?: Record<string, string[]> };
}) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [lineIds, setLineIds] = useState<string[]>([]);
  const [createPassword, setCreatePassword] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const toggle = (id: string, on: boolean) => setLineIds((list) => (on ? [...list.filter((x) => x !== id), id] : list.filter((x) => x !== id)));
  return (
    <form
      className="flex flex-col gap-3 rounded-card border border-line bg-card px-4 py-3"
      data-testid="access-add"
      onKeyDown={(e) => e.key === "Escape" && onCancel()}
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await addUserAccount({ email, name, lineIds, createPassword, ...extraInput }).catch(() => ({ ok: false as const, message: LineAccessCopy.SAVE_ERROR }));
          if (r.ok) onAdded(r);
          else setError(r.message);
        });
      }}
    >
      <h3 className="type-heading">{PasswordCopy.ADD_TITLE}</h3>
      <div className="flex gap-3">
        <label className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-muted type-caption">{LineAccessCopy.ADD_FIELD}</span>
          <input ref={ref} type="email" required value={email} aria-invalid={error ? true : undefined} onChange={(e) => setEmail(e.target.value)} className={INPUT} />
        </label>
        <label className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-muted type-caption">{PasswordCopy.ADD_NAME}</span>
          <input type="text" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} className={INPUT} />
        </label>
      </div>
      <fieldset className="flex flex-col gap-1.5">
        <legend className="mb-1 text-muted type-caption">{PasswordCopy.ADD_LINES}</legend>
        <div className={lineExtra ? "flex flex-col gap-2" : "flex flex-wrap gap-x-5 gap-y-1.5"}>
          {lines.map((l) => {
            const on = lineIds.includes(l.id);
            return (
              <div key={l.id} className="flex flex-col gap-1">
                <label className="flex cursor-pointer items-center gap-2 type-table" title={l.name}>
                  <input type="checkbox" className="size-4 cursor-pointer accent-accent" checked={on} onChange={(e) => toggle(l.id, e.target.checked)} data-add-line={l.shortName} />
                  <span className="type-table-strong">{l.shortName}</span>
                  <span className="text-muted">{l.name}</span>
                </label>
                {lineExtra?.(l, on, (next) => toggle(l.id, next))}
              </div>
            );
          })}
        </div>
        {lineIds.length === 0 && (
          <p className="rounded-control bg-(--status-at-risk-dark-bg) px-2.5 py-1.5 text-(--status-at-risk-dark-fg) type-caption" data-testid="access-add-no-lines">
            {PasswordCopy.ADD_NO_LINES}
          </p>
        )}
      </fieldset>
      <label className="flex cursor-pointer items-start gap-2">
        <input type="checkbox" className="mt-0.5 size-4 cursor-pointer accent-accent" checked={createPassword} onChange={(e) => setCreatePassword(e.target.checked)} data-testid="access-add-temp" />
        <span className="flex flex-col">
          <span className="type-table">{PasswordCopy.ADD_TEMP}</span>
          <span className="text-muted type-caption">{PasswordCopy.ADD_TEMP_HELP}</span>
        </span>
      </label>
      {error && (
        <p role="alert" className="text-danger type-caption">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button type="button" className={GHOST} onClick={onCancel}>
          {LineAccessCopy.CANCEL}
        </button>
        <button type="submit" className={PRIMARY} disabled={pending}>
          {PasswordCopy.ADD_SAVE}
        </button>
      </div>
    </form>
  );
}

/** Shows a new temporary password once, with Copy. Closing it is the last time anyone sees it. */
export function TempPasswordDialog({ name, email, password, onDone }: { name: string; email: string; password: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onDone();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDone]);
  return (
    <div className="sl-scrim">
      <div role="dialog" aria-modal="true" aria-labelledby="temp-password-title" data-testid="temp-password" className="flex w-[440px] flex-col gap-3 rounded-card border border-line bg-card px-5 py-4 shadow-[0_12px_32px_rgba(0,0,0,.45)]">
        <h2 id="temp-password-title" className="type-heading">
          {PasswordCopy.tempFor(name)}
        </h2>
        <p className="type-table text-muted">{email}</p>
        <div className="flex items-center gap-2 rounded-control border border-line bg-input px-3 py-2">
          <code className="flex-1 select-all font-mono text-[15px] tracking-wide text-fg" data-testid="temp-password-value">
            {password}
          </code>
          <button
            type="button"
            className={GHOST}
            onClick={() => {
              void navigator.clipboard?.writeText(password).then(() => setCopied(true));
            }}
          >
            {copied ? PasswordCopy.COPIED : PasswordCopy.COPY}
          </button>
        </div>
        <p className="type-caption text-muted">{PasswordCopy.TEMP_BODY}</p>
        <div className="flex justify-end">
          <button type="button" autoFocus className={PRIMARY} onClick={onDone}>
            {PasswordCopy.DONE}
          </button>
        </div>
      </div>
    </div>
  );
}
