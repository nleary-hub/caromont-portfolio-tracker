"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createRole, deleteRole, duplicateRole, renameRole, saveRoleKeys } from "@/app/actions/roles";
import { GRANTABLE_KEYS, PERMISSION_GROUPS, VISIBLE_LOCKED_KEYS, type PermissionGroup } from "@/lib/permissions/PermissionKeys";
import { EDITOR_COLUMNS, GROUP_LABELS, KEY_LABELS, type VisibleKey } from "@/lib/permissions/RoleLabels";
import type { RoleRow, RolesData } from "@/lib/services/RoleService";
import s from "@/components/RolesEditor.module.css";

const GRANT_LIMIT = "You can only give permissions you have.";
const VISIBLE_TOTAL = GRANTABLE_KEYS.length + VISIBLE_LOCKED_KEYS.length;
const LOCKED = new Set<string>(VISIBLE_LOCKED_KEYS);
const AVATAR_COLORS = ["#0e7490", "#7c3aed", "#b45309", "#15803d", "#be185d", "#475569"];

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(" ");
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
const displayName = (r: Pick<RoleRow, "name" | "isSystem">) => (r.isSystem ? r.name : `${r.name} (custom)`);
const initials = (name: string) => name.split(/[\s.]+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join("");

function Icon({ d, size }: { d: string; size?: number }) {
  return (
    <svg className={s.ic} viewBox="0 0 24 24" style={size ? { width: size, height: size } : undefined} aria-hidden>
      <path d={d} />
    </svg>
  );
}
const LOCK = "M6 11h12a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2zM8 11V7a4 4 0 0 1 8 0v4";
const USER = "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0";
const PEN = "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z";
const TRASH = "M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14";

export function RolesEditor({ data, initialRoleId }: { data: RolesData; initialRoleId?: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const firstEditable = data.roles.find((r) => r.editable)?.id ?? data.roles[0]?.id;
  const [selectedId, setSelectedId] = useState(initialRoleId && data.roles.some((r) => r.id === initialRoleId) ? initialRoleId : firstEditable);
  const selected = data.roles.find((r) => r.id === selectedId) ?? data.roles[0];
  const [draft, setDraft] = useState<Set<string>>(() => new Set(selected?.keys ?? []));
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const [dialog, setDialog] = useState<null | { kind: "new" } | { kind: "rename"; role: RoleRow } | { kind: "delete"; role: RoleRow }>(null);
  const grantable = useMemo(() => new Set(data.grantable), [data.grantable]);
  const system = data.roles.filter((r) => r.isSystem);
  const custom = data.roles.filter((r) => !r.isSystem);

  const saved = useMemo(() => new Set(selected?.keys ?? []), [selected]);
  // After a save or refresh, the server's keys for the open role replace the draft.
  const savedSig = `${selected?.id}:${[...saved].sort().join(",")}`;
  const [lastSig, setLastSig] = useState(savedSig);
  if (savedSig !== lastSig) {
    setLastSig(savedSig);
    setDraft(new Set(saved));
  }
  const changes = [...draft].filter((k) => !saved.has(k)).length + [...saved].filter((k) => !draft.has(k)).length;

  const select = (role: RoleRow) => {
    setSelectedId(role.id);
    setDraft(new Set(role.keys));
    setMessage(null);
  };
  const after = (res: { ok: boolean; message: string; roleId?: string }, onOk?: () => void) => {
    setMessage({ error: !res.ok, text: res.message });
    if (res.ok) {
      onOk?.();
      router.refresh();
    }
  };
  const toggle = (key: string) => {
    if (!selected?.editable) return;
    const next = new Set(draft);
    if (next.has(key)) next.delete(key);
    else {
      if (!grantable.has(key)) return setMessage({ error: true, text: GRANT_LIMIT });
      next.add(key);
    }
    setMessage(null);
    setDraft(next);
  };
  const save = () => selected && start(async () => after(await saveRoleKeys(selected.id, [...draft])));

  if (!selected) return null;
  const onCount = [...draft].filter((k) => !LOCKED.has(k)).length;

  const roleRow = (r: RoleRow) => (
    <div key={r.id} role="button" tabIndex={0} data-testid={`role-row-${r.id}`} className={cx(s.role, r.id === selected.id && s.sel)} onClick={() => select(r)} onKeyDown={(e) => e.key === "Enter" && select(r)}>
      <div style={{ minWidth: 0 }}>
        <div className={s.rname}>
          {r.name}
          {!r.isSystem && <span className={s.dim} style={{ fontWeight: 400 }}>(custom)</span>}
        </div>
        <div className={s.rmeta}>{r.description}</div>
      </div>
      <span className={s.cnt} title={plural(r.users.length, "user")}>
        <Icon d={USER} size={11} />
        {r.users.length}
      </span>
      <div className={s.acts}>
        <button type="button" className={s.iconbtn} aria-label={`Rename ${r.name}`} disabled={!r.editable} onClick={(e) => { e.stopPropagation(); setDialog({ kind: "rename", role: r }); }}>
          <Icon d={PEN} />
        </button>
        <button type="button" className={s.iconbtn} aria-label={`Delete ${r.name}`} data-testid={`delete-role-${r.id}`} disabled={!r.editable || r.isSystem} title={r.isSystem ? "System roles can't be deleted." : undefined} onClick={(e) => { e.stopPropagation(); setDialog({ kind: "delete", role: r }); }}>
          <Icon d={TRASH} />
        </button>
      </div>
    </div>
  );

  const group = (g: PermissionGroup) => {
    const keys = PERMISSION_GROUPS[g] as readonly VisibleKey[];
    const counted = keys.filter((k) => !LOCKED.has(k));
    const on = counted.filter((k) => draft.has(k)).length;
    return (
      <div key={g} className={cx(s.grp, g === "ai" && s.ai, g === "admin" && s.admin)} data-testid={`group-${g}`}>
        <div className={s.gh}>
          {GROUP_LABELS[g].name}
          <span className={s.gc}>{`${on} of ${counted.length} on`}</span>
        </div>
        <div className={s.gd}>{GROUP_LABELS[g].helper}</div>
        {g === "ai" && (
          <div className={cx(s.t, s.capRow)}>
            <div className={s.tl}>
              <div className={s.tn}>Monthly AI cap per user</div>
              <div className={s.td}>Set by the owner</div>
            </div>
            <div className={s.select} style={{ height: 22, width: 72, fontSize: 11.5, padding: "0 6px", color: "#9aa3b2", cursor: "default" }}>
              <span style={{ whiteSpace: "nowrap" }}>No cap</span>
              <Icon d={LOCK} size={12} />
            </div>
          </div>
        )}
        {keys.map((k) =>
          LOCKED.has(k) ? (
            <div key={k} className={cx(s.t, s.lk)} data-testid={`key-${k}`} data-locked="true">
              <div className={s.tl}>
                <div className={s.tn}>{KEY_LABELS[k].label}</div>
                <div className={s.td}>{KEY_LABELS[k].helper}</div>
                <div className={s.tk}>{k}</div>
              </div>
              <span className={s.lockIcon} aria-label="Owner only">
                <Icon d={LOCK} size={12} />
              </span>
            </div>
          ) : (
            <div key={k} className={s.t} data-testid={`key-${k}`}>
              <div className={s.tl}>
                <div className={s.tn}>{KEY_LABELS[k].label}</div>
                <div className={s.td}>{KEY_LABELS[k].helper}</div>
                <div className={s.tk}>{k}</div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={draft.has(k)}
                aria-label={KEY_LABELS[k].label}
                disabled={!selected.editable}
                title={!grantable.has(k) && !draft.has(k) ? GRANT_LIMIT : undefined}
                className={cx(s.sw, !grantable.has(k) && !draft.has(k) && s.swNoGrant)}
                onClick={() => toggle(k)}
              />
            </div>
          ),
        )}
      </div>
    );
  };

  return (
    <div className={s.page}>
      <div>
        <h1 className={s.h1}>Roles &amp; permissions</h1>
        <div className={s.muted} style={{ marginTop: 4 }}>
          {VISIBLE_TOTAL} permission keys in 7 groups. The Owner has every key and is not a role you can assign.
        </div>
      </div>
      <div className={s.split}>
        <div className={cx(s.glass, s.list)}>
          <div className={s.lh}>
            <div>
              <span style={{ fontWeight: 600 }}>Roles</span> <span className={s.dim} style={{ marginLeft: 4 }}>{data.roles.length + 1}</span>
            </div>
            <button type="button" className={cx(s.btn, s.pri, s.sm)} onClick={() => setDialog({ kind: "new" })}>
              <Icon d="M12 5v14M5 12h14" size={13} />
              New role
            </button>
          </div>
          <div className={cx(s.role, s.locked)} data-testid="role-row-owner">
            <div>
              <div className={s.rname}>
                <span style={{ color: "#fbbf24", display: "flex" }}>
                  <Icon d={LOCK} size={12} />
                </span>
                Owner
              </div>
              <div className={s.rmeta}>Can&apos;t be edited or assigned</div>
            </div>
            <span className={s.cnt}>
              <Icon d={USER} size={11} />
              {data.ownerCount}
            </span>
          </div>
          {system.map(roleRow)}
          {custom.length > 0 && <div className={s.navh}>Custom roles</div>}
          {custom.map(roleRow)}
          <div className={s.note}>Deleting a role moves its users to a role you pick first.</div>
        </div>

        <div className={cx(s.glass, s.ed)} data-testid="role-editor">
          <div className={s.eh}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>{selected.name}</div>
            <span className={s.dim}>{`· ${plural(selected.users.length, "user")} · ${onCount} of ${VISIBLE_TOTAL} permissions on`}</span>
            {!selected.editable && (
              <span className={s.dim} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <Icon d={LOCK} size={12} />
                You can only change roles below your own.
              </span>
            )}
            <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
              <button type="button" className={cx(s.btn, s.sm)} disabled={!selected.editable || pending} onClick={() => start(async () => after(await duplicateRole(selected.id)))}>
                Duplicate
              </button>
              <button type="button" className={cx(s.btn, s.sm)} disabled={!selected.editable} onClick={() => setDialog({ kind: "rename", role: selected })}>
                Rename
              </button>
            </div>
          </div>
          <div className={s.grid}>
            {EDITOR_COLUMNS.map((col, i) => (
              <div key={i} className={s.col}>
                {col.map(group)}
              </div>
            ))}
          </div>
          <div className={s.foot}>
            <span className={cx(message?.error ? s.err : s.dim)} data-testid="roles-message" role={message?.error ? "alert" : undefined}>
              {message?.text ?? (changes > 0 ? `Unsaved changes: ${changes}` : "No unsaved changes")}
            </span>
            <button type="button" className={cx(s.btn, s.sm)} style={{ marginLeft: "auto" }} disabled={changes === 0 || pending} onClick={() => select(selected)}>
              Discard
            </button>
            <button type="button" className={cx(s.btn, s.pri, s.sm)} disabled={changes === 0 || pending || !selected.editable} onClick={save}>
              Save changes
            </button>
          </div>
        </div>
      </div>

      {dialog?.kind === "delete" && (
        <DeleteDialog
          role={dialog.role}
          targets={data.roles.filter((r) => r.editable && r.id !== dialog.role.id)}
          pending={pending}
          onCancel={() => setDialog(null)}
          onDelete={(moveTo) =>
            start(async () => {
              const res = await deleteRole(dialog.role.id, moveTo);
              after(res, () => {
                setDialog(null);
                if (selected.id === dialog.role.id && firstEditable) setSelectedId(firstEditable);
              });
            })
          }
        />
      )}
      {(dialog?.kind === "new" || dialog?.kind === "rename") && (
        <NameDialog
          title={dialog.kind === "new" ? "New role" : `Rename “${displayName(dialog.role)}”`}
          initialName={dialog.kind === "rename" ? dialog.role.name : ""}
          initialDescription={dialog.kind === "rename" ? dialog.role.description : ""}
          showDescription={data.descriptions && (dialog.kind === "new" || !dialog.role.isSystem)}
          pending={pending}
          onCancel={() => setDialog(null)}
          onSave={(name, description) =>
            start(async () => {
              const res = dialog.kind === "new" ? await createRole(name, description) : await renameRole(dialog.role.id, name, description);
              after(res, () => setDialog(null));
            })
          }
        />
      )}
    </div>
  );
}

function DeleteDialog({ role, targets, pending, onCancel, onDelete }: { role: RoleRow; targets: RoleRow[]; pending: boolean; onCancel: () => void; onDelete: (moveTo: string | null) => void }) {
  const holders = role.users;
  const fallback = [...targets].sort((a, b) => a.rank - b.rank)[0]?.id ?? null;
  const [moveTo, setMoveTo] = useState<string | null>(fallback);
  const [open, setOpen] = useState(false);
  const current = targets.find((t) => t.id === moveTo);
  const blocked = holders.length > 0 && !current;
  return (
    <div className={s.overlay} role="dialog" aria-modal="true" aria-labelledby="delete-role-title" data-testid="delete-role-dialog">
      <div className={s.dlg}>
        <div style={{ display: "flex", gap: 12 }}>
          <div className={s.dlgIcon}>
            <Icon d={TRASH} />
          </div>
          <div>
            <div id="delete-role-title" style={{ fontSize: 15, fontWeight: 600 }}>{`Delete “${displayName(role)}”?`}</div>
            <div className={s.muted} style={{ marginTop: 6, lineHeight: 1.5 }}>
              {holders.length > 0
                ? `${holders.length === 1 ? "1 user still has" : `${holders.length} users still have`} this role. Pick a role to move them to before you delete it. This can't be undone.`
                : "No users have this role. This can't be undone."}
            </div>
          </div>
        </div>
        {holders.length > 0 && (
          <div style={{ margin: "16px 0 0 46px" }}>
            <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
              {holders.slice(0, 5).map((u, i) => (
                <div key={u.email} className={s.av} style={{ background: AVATAR_COLORS[i % AVATAR_COLORS.length] }}>
                  {initials(u.name)}
                </div>
              ))}
              <span className={s.muted} style={{ alignSelf: "center", marginLeft: 4, fontSize: 12 }}>
                {holders.map((u) => u.name).join(", ")}
              </span>
            </div>
            <span className={s.label}>Move users to</span>
            <button type="button" className={cx(s.select, open && s.selectOpen)} aria-haspopup="listbox" aria-expanded={open} data-testid="move-to" onClick={() => setOpen(!open)}>
              <span>{current?.name ?? "Pick a role"}</span>
              <Icon d="m6 9 6 6 6-6" size={13} />
            </button>
            {open && (
              <div className={s.menu} role="listbox">
                {targets.map((t) => (
                  <button key={t.id} type="button" role="option" aria-selected={t.id === moveTo} className={cx(s.mi, t.id === moveTo && s.hl)} onClick={() => { setMoveTo(t.id); setOpen(false); }}>
                    <span style={{ width: 14, display: "flex" }}>{t.id === moveTo && <Icon d="M20 6 9 17l-5-5" size={13} />}</span>
                    {t.isSystem ? t.name : displayName(t)}
                    <span className={s.dim} style={{ marginLeft: "auto", fontSize: 11.5 }}>{plural(t.users.length, "user")}</span>
                  </button>
                ))}
                <div className={s.menuNote}>You can assign roles below your own</div>
              </div>
            )}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
          <button type="button" className={s.btn} onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className={cx(s.btn, s.red)} disabled={pending || blocked} onClick={() => onDelete(holders.length > 0 ? moveTo : null)}>
            Delete role
          </button>
        </div>
      </div>
    </div>
  );
}

function NameDialog({ title, initialName, initialDescription, showDescription, pending, onCancel, onSave }: { title: string; initialName: string; initialDescription: string; showDescription: boolean; pending: boolean; onCancel: () => void; onSave: (name: string, description: string) => void }) {
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  return (
    <div className={s.overlay} role="dialog" aria-modal="true" aria-label={title}>
      <form className={s.dlg} onSubmit={(e) => { e.preventDefault(); onSave(name, description); }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 14 }}>{title}</div>
        <label className={s.label} htmlFor="role-name">Name</label>
        <input id="role-name" className={s.input} value={name} maxLength={40} autoFocus onChange={(e) => setName(e.target.value)} />
        {showDescription && (
          <>
            <label className={s.label} htmlFor="role-description" style={{ marginTop: 12 }}>Description</label>
            <input id="role-description" className={s.input} value={description} maxLength={80} onChange={(e) => setDescription(e.target.value)} />
          </>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 18 }}>
          <button type="button" className={s.btn} onClick={onCancel}>Cancel</button>
          <button type="submit" className={cx(s.btn, s.pri)} disabled={pending || !name.trim()}>Save</button>
        </div>
      </form>
    </div>
  );
}
