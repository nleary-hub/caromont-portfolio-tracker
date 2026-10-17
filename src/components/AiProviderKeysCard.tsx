"use client";

import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { deleteProviderKey, rotateProviderKey, saveProviderKey, testProviderKey } from "@/app/actions/aiKeys";
import { AiAlert } from "@/components/AiNoteAssistant";
import { AiKeyCopy as C, AiKeyProviders, type AiKeyActionResult, type AiKeyActionView, type AiKeyProvider, type AiKeyRowView } from "@/lib/ai/AiKeyProviders";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const INPUT = `h-7 w-full min-w-0 rounded-control border border-line bg-input px-2.5 text-fg type-table focus:border-accent disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger ${FOCUS}`;
const GHOST = `h-7 rounded-control px-2.5 text-muted type-table-strong hover:bg-white/5 hover:text-fg disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent ${FOCUS}`;
const OUTLINE = `h-7 rounded-control border border-accent/70 px-3 text-accent type-table-strong hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS}`;
const PRIMARY = `h-7 rounded-control btn-primary bg-accent-strong px-3 text-white type-table-strong disabled:cursor-not-allowed disabled:bg-(--status-not-started-dark-bg) disabled:text-muted ${FOCUS}`;
const ICON = `grid size-7 place-items-center rounded-control text-muted hover:bg-(--status-off-track-dark-bg) hover:text-danger disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted ${FOCUS}`;

/** The four actions; the page passes nothing (the real Server Functions), the browser fixture passes fakes. */
export interface AiKeyActions {
  save: (provider: AiKeyProvider, apiKey: string, baseUrl?: string, label?: string) => Promise<AiKeyActionResult>;
  rotate: (provider: AiKeyProvider, apiKey: string) => Promise<AiKeyActionResult>;
  test: (provider: AiKeyProvider) => Promise<AiKeyActionResult>;
  remove: (provider: AiKeyProvider, confirmed: boolean) => Promise<AiKeyActionResult>;
}

const SERVER: AiKeyActions = { save: saveProviderKey, rotate: rotateProviderKey, test: testProviderKey, remove: deleteProviderKey };

/** Dates on the card, in the team's time zone. */
export class AiKeyFormat {
  static readonly ZONE = "America/New_York";
  private static readonly DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: AiKeyFormat.ZONE });
  private static readonly TIME = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: AiKeyFormat.ZONE });
  private static readonly FULL = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: AiKeyFormat.ZONE });

  static day(iso: string): string {
    return AiKeyFormat.DAY.format(new Date(iso));
  }

  static time(iso: string): string {
    return AiKeyFormat.TIME.format(new Date(iso));
  }

  static full(iso: string): string {
    return `${AiKeyFormat.FULL.format(new Date(iso))} ET`;
  }
}

type Mode = { kind: "idle" } | { kind: "entry"; entry: "add" | "replace" | "rotate" } | { kind: "busy"; busy: "saving" | "testing" | "rotating" | "deleting" };

/** 14px monochrome glyphs (no brand logos). */
function Glyph({ provider }: { provider: AiKeyProvider }) {
  const p = { width: 14, height: 14, viewBox: "0 0 14 14", fill: "none", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  switch (provider) {
    case "openai":
      return (
        <svg {...p}>
          <circle cx="7" cy="7" r="5.2" />
          <circle cx="7" cy="7" r="1.6" />
        </svg>
      );
    case "anthropic":
      return (
        <svg {...p}>
          <path d="M2.2 11.8 7 2.2l4.8 9.6" />
          <path d="M4.2 8h5.6" />
        </svg>
      );
    case "xai":
      return (
        <svg {...p}>
          <path d="M3 3l8 8M11 3 3 11" />
        </svg>
      );
    case "other":
      return (
        <svg {...p}>
          <path d="M5.5 8.5 8.5 5.5" />
          <path d="M6.2 3.8 7.4 2.6a2.6 2.6 0 0 1 3.7 3.7L9.9 7.5M4.1 6.5 2.9 7.7a2.6 2.6 0 0 0 3.7 3.7l1.2-1.2" />
        </svg>
      );
  }
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2.5 4h9M5.5 4V2.6h3V4M3.8 4l.6 7.4h5.2l.6-7.4" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg width="8" height="8" viewBox="0 0 10 10" aria-hidden className="animate-spin motion-reduce:animate-none" data-testid="key-spinner">
      <circle cx="5" cy="5" r="4" fill="none" stroke="currentColor" strokeOpacity=".3" strokeWidth="1.5" />
      <path d="M5 1a4 4 0 0 1 4 4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Admin > AI settings > Provider keys (design spec, Oct 17, 2026): one compact 44px row per provider with a status dot,
 * the masked key and who set it when, and Test, Replace, Rotate and Delete. Keys are write-only: the page and every
 * action response carry only provider, last 4, set date and status. On a preview the card is read-only and nothing
 * decrypts (the server refuses too).
 */
export function AiProviderKeysCard({
  rows,
  preview,
  dbReady,
  encryptionReady,
  adminName,
  actions = SERVER,
}: {
  rows: readonly AiKeyRowView[];
  preview: boolean;
  dbReady: boolean;
  encryptionReady: boolean;
  /** The signed-in admin's display name, for "Set Oct 17 by ..." after a change on this page. */
  adminName: string | null;
  actions?: AiKeyActions;
}) {
  const readOnly = preview || !dbReady;
  return (
    <div className="flex flex-col gap-3" data-testid="provider-keys" data-preview={preview || undefined}>
      <div>
        <h2 id="provider-keys-heading" className="type-heading">
          {C.TITLE}
        </h2>
        <p className="mt-0.5 text-muted type-caption">{C.CAPTION}</p>
      </div>
      {preview && (
        <p className="rounded-control bg-(--status-at-risk-dark-bg) px-3 py-2 text-(--status-at-risk-dark-fg) type-table" role="status" data-testid="provider-keys-preview">
          {C.PREVIEW_BANNER}
        </p>
      )}
      {!preview && !encryptionReady && (
        <p className="rounded-control bg-(--status-at-risk-dark-bg) px-3 py-2 text-(--status-at-risk-dark-fg) type-table" role="status" data-testid="provider-keys-encryption">
          {C.ENCRYPTION_MISSING}
        </p>
      )}
      <ul className="flex flex-col divide-y divide-line rounded-control border border-line bg-white/[0.02]">
        {rows.map((r) => (
          <KeyRow key={r.provider} initial={r} readOnly={readOnly} preview={preview} canWrite={!readOnly && encryptionReady} adminName={adminName} actions={actions} />
        ))}
      </ul>
    </div>
  );
}

function KeyRow({ initial, readOnly, preview, canWrite, adminName, actions }: { initial: AiKeyRowView; readOnly: boolean; preview: boolean; canWrite: boolean; adminName: string | null; actions: AiKeyActions }) {
  const provider = initial.provider;
  const [row, setRow] = useState<AiKeyRowView>(initial);
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const [error, setError] = useState<{ message: string; retry: "test" | "rotate" } | null>(
    preview || !initial.set ? null : !initial.readable ? { message: C.UNREADABLE, retry: "test" } : initial.status.message ? { message: initial.status.message, retry: "test" } : null,
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const busy = mode.kind === "busy";
  const name = AiKeyProviders.pickerName(provider, provider === "other" ? row.label : null);
  const label = provider === "other" ? AiKeyProviders.label("other") : name;

  const apply = (v: Partial<AiKeyActionView>, changedKey: boolean) =>
    setRow((cur) => ({
      ...cur,
      ...(v.provider ? { last4: v.last4 ?? "", setAt: v.setAt ?? null, status: v.status ?? cur.status, set: Boolean(v.setAt) || (v.status ? v.status.state !== "none" : cur.set) } : {}),
      ...(changedKey ? { setBy: adminName, readable: true } : {}),
    }));

  const runTest = async () => {
    setError(null);
    setMode({ kind: "busy", busy: "testing" });
    const r = await actions.test(provider).catch((): AiKeyActionResult => ({ ok: false, error: C.SAVE_FAILED }));
    if (r?.provider) apply(r, false);
    if (!r?.ok) setError({ message: (r?.status?.message ?? r?.error) || C.SAVE_FAILED, retry: "test" });
    setMode({ kind: "idle" });
  };

  const submit = async (entry: "add" | "replace" | "rotate", key: string, baseUrl: string, displayName: string): Promise<{ baseUrl?: string; apiKey?: string; label?: string } | null> => {
    setError(null);
    if (entry === "rotate") {
      setMode({ kind: "busy", busy: "rotating" });
      const r = await actions.rotate(provider, key).catch((): AiKeyActionResult => ({ ok: false, error: C.SAVE_FAILED }));
      if (r?.provider) apply(r, r.ok);
      if (!r?.ok) setError({ message: (r?.status?.message ?? r?.error) || C.SAVE_FAILED, retry: "rotate" });
      setMode({ kind: "idle" });
      return null;
    }
    setMode({ kind: "busy", busy: "saving" });
    const r = await actions.save(provider, key, provider === "other" ? baseUrl : undefined, provider === "other" ? displayName : undefined).catch((): AiKeyActionResult => ({ ok: false, error: C.SAVE_FAILED }));
    if (!r?.ok) {
      setMode({ kind: "entry", entry });
      if (r && "fieldErrors" in r && r.fieldErrors && Object.keys(r.fieldErrors).length) return r.fieldErrors;
      setError({ message: r?.error || C.SAVE_FAILED, retry: "test" });
      return null;
    }
    apply(r, true);
    if (provider === "other") setRow((cur) => ({ ...cur, baseUrl: baseUrl.trim(), label: displayName.trim() || null }));
    // Saving runs Test at once; a key that fails its test stays saved.
    await runTest();
    return null;
  };

  const doDelete = async () => {
    setConfirmDelete(false);
    setMode({ kind: "busy", busy: "deleting" });
    const r = await actions.remove(provider, true).catch((): AiKeyActionResult => ({ ok: false, error: C.SAVE_FAILED }));
    if (r?.ok) {
      setRow((cur) => ({ ...cur, set: false, last4: "", setAt: null, setBy: null, status: { state: "none", testedAt: null, message: null } }));
      setError(null);
    } else setError({ message: r?.error || C.SAVE_FAILED, retry: "test" });
    setMode({ kind: "idle" });
  };

  const unreadable = !preview && row.set && !row.readable;
  const state = row.status.state;
  let dot = "bg-(--status-not-started-dark-fg)";
  let text: ReactNode = C.NO_KEY;
  if (mode.kind === "busy" && mode.busy === "rotating") text = C.ROTATING;
  else if (busy && mode.busy !== "deleting") text = C.TESTING;
  else if (!row.set) text = C.NO_KEY;
  else if (state === "ok") {
    dot = "bg-(--status-on-track-dark-fg)";
    text = row.status.testedAt ? C.working(AiKeyFormat.time(row.status.testedAt)) : C.working("");
  } else if (state === "rejected" || state === "unreachable" || state === "error" || unreadable) {
    dot = "bg-(--status-at-risk-dark-fg)";
    text = C.TEST_FAILED;
  } else {
    dot = "bg-(--status-not-started-dark-fg)";
    text = C.NOT_TESTED;
  }
  const spinning = busy && mode.busy !== "deleting";

  return (
    <li className="flex flex-col" data-testid={`key-row-${provider}`} data-state={spinning ? (mode.kind === "busy" ? mode.busy : "") : row.set ? state : "none"}>
      <div className="flex h-11 items-center gap-2.5 px-3">
        <span className="text-muted">
          <Glyph provider={provider} />
        </span>
        <span className="min-w-0 truncate type-table-strong text-fg" data-testid="key-name">
          {provider === "other" && row.label ? name : label}
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-muted type-caption" role="status" aria-live="polite" data-testid="key-status">
          {spinning ? <Spinner /> : <span aria-hidden className={`size-2 rounded-full ${dot}`} data-testid="key-dot" />}
          {text}
        </span>
        <span className="ml-auto flex min-w-0 items-center gap-2">
          {row.set && (
            <span className="flex min-w-0 items-center gap-2" data-testid="key-meta">
              <span className="font-mono text-fg type-table" data-testid="key-mask">
                •••• {row.last4}
              </span>
              {row.setAt && (
                <span className="truncate text-muted type-caption" title={AiKeyFormat.full(row.setAt)} data-testid="key-set">
                  {C.set(AiKeyFormat.day(row.setAt), row.setBy)}
                </span>
              )}
            </span>
          )}
          {!readOnly && (
            <span className="flex shrink-0 items-center gap-0.5" data-testid="key-actions">
              {!row.set ? (
                mode.kind !== "entry" && (
                  <button type="button" className={OUTLINE} disabled={busy || !canWrite} onClick={() => setMode({ kind: "entry", entry: "add" })} data-testid="key-add">
                    {C.ADD}
                  </button>
                )
              ) : (
                <>
                  <button type="button" className={GHOST} disabled={busy || mode.kind === "entry" || !canWrite} onClick={runTest} data-testid="key-test">
                    {C.TEST}
                  </button>
                  <button type="button" className={GHOST} disabled={busy || mode.kind === "entry" || !canWrite} onClick={() => setMode({ kind: "entry", entry: "replace" })} data-testid="key-replace">
                    {C.REPLACE}
                  </button>
                  <button type="button" className={GHOST} disabled={busy || mode.kind === "entry" || !canWrite} onClick={() => setMode({ kind: "entry", entry: "rotate" })} data-testid="key-rotate">
                    {C.ROTATE}
                  </button>
                  <button ref={deleteButton} type="button" className={ICON} disabled={busy || mode.kind === "entry" || !canWrite} onClick={() => setConfirmDelete(true)} aria-label={`${C.DELETE}: ${label}`} title={C.DELETE} data-testid="key-delete">
                    <TrashIcon />
                  </button>
                </>
              )}
            </span>
          )}
        </span>
      </div>
      {mode.kind === "entry" && !readOnly && (
        <KeyEntry
          provider={provider}
          entry={mode.entry}
          initialBaseUrl={row.baseUrl ?? ""}
          initialLabel={row.label ?? ""}
          onCancel={() => setMode({ kind: "idle" })}
          onSubmit={(key, baseUrl, displayName) => submit(mode.entry, key, baseUrl, displayName)}
        />
      )}
      {error && !readOnly && (
        <div className="px-3 pb-2.5">
          <AiAlert tone="danger" testId="key-error">
            {error.message}{" "}
            <button
              type="button"
              className={`underline underline-offset-2 hover:text-fg ${FOCUS}`}
              disabled={busy}
              onClick={() => (error.retry === "rotate" ? (setError(null), setMode({ kind: "entry", entry: "rotate" })) : runTest())}
              data-testid="key-retry"
            >
              {C.RETRY}
            </button>
          </AiAlert>
        </div>
      )}
      {confirmDelete && (
        <DeleteKeyDialog
          provider={provider}
          featuresUsing={row.featuresUsing}
          onCancel={() => {
            setConfirmDelete(false);
            deleteButton.current?.focus();
          }}
          onConfirm={doDelete}
        />
      )}
    </li>
  );
}

/** The inline entry: Base URL and Display name first for "other", then the password field with Show, Save and Cancel. */
function KeyEntry({
  provider,
  entry,
  initialBaseUrl,
  initialLabel,
  onCancel,
  onSubmit,
}: {
  provider: AiKeyProvider;
  entry: "add" | "replace" | "rotate";
  initialBaseUrl: string;
  initialLabel: string;
  onCancel: () => void;
  onSubmit: (key: string, baseUrl: string, label: string) => Promise<{ baseUrl?: string; apiKey?: string; label?: string } | null>;
}) {
  const [key, setKey] = useState("");
  const [show, setShow] = useState(false);
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl);
  const [label, setLabel] = useState(initialLabel);
  const [errors, setErrors] = useState<{ baseUrl?: string; apiKey?: string; label?: string }>({});
  const [sending, setSending] = useState(false);
  const other = provider === "other" && entry !== "rotate";
  const title = entry === "add" ? C.ADD : entry === "replace" ? C.REPLACE_LABEL : C.ROTATE_LABEL;
  const blank = !key.trim();

  const save = async () => {
    if (blank || sending) return;
    if (other && !AiKeyProviders.httpsUrl(baseUrl)) {
      setErrors({ baseUrl: C.INVALID_URL });
      return;
    }
    setSending(true);
    const typed = key;
    // The field clears as soon as the key is sent; it is never kept in the page.
    setKey("");
    const fieldErrors = await onSubmit(typed, baseUrl, label);
    setSending(false);
    if (fieldErrors) setErrors(fieldErrors);
  };
  const keys = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void save();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }
  };
  const id = `key-${provider}`;

  return (
    <fieldset className="flex flex-col gap-2 px-3 pb-3 pl-[37px]" aria-label={`${title}: ${AiKeyProviders.label(provider)}`} data-testid="key-entry" data-entry={entry} onKeyDown={keys}>
      <legend className="sr-only">{title}</legend>
      {other && (
        <div className="grid grid-cols-[1fr_200px] gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-muted type-caption">{C.BASE_URL}</span>
            <input
              id={`${id}-base-url`}
              className={INPUT}
              value={baseUrl}
              onChange={(e) => {
                setBaseUrl(e.target.value);
                if (errors.baseUrl) setErrors((x) => ({ ...x, baseUrl: undefined }));
              }}
              onBlur={() => baseUrl.trim() && !AiKeyProviders.httpsUrl(baseUrl) && setErrors((x) => ({ ...x, baseUrl: C.INVALID_URL }))}
              placeholder="https://"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              maxLength={AiKeyProviders.URL_MAX}
              aria-invalid={Boolean(errors.baseUrl) || undefined}
              aria-describedby={errors.baseUrl ? `${id}-base-url-error` : undefined}
              data-testid="key-base-url"
            />
            {errors.baseUrl && (
              <span id={`${id}-base-url-error`} className="text-danger type-caption" data-testid="key-base-url-error">
                {errors.baseUrl}
              </span>
            )}
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-muted type-caption">{C.DISPLAY_NAME}</span>
            <input className={INPUT} value={label} onChange={(e) => setLabel(e.target.value)} placeholder={C.DISPLAY_NAME_PLACEHOLDER} maxLength={AiKeyProviders.LABEL_MAX} autoComplete="off" data-testid="key-label" />
            {errors.label && <span className="text-danger type-caption">{errors.label}</span>}
          </label>
        </div>
      )}
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <input
            id={`${id}-input`}
            type={show ? "text" : "password"}
            className={`${INPUT} pr-16 font-mono`}
            value={key}
            onChange={(e) => {
              setKey(e.target.value);
              if (errors.apiKey) setErrors((x) => ({ ...x, apiKey: undefined }));
            }}
            aria-label={title}
            placeholder={title}
            autoComplete="new-password"
            spellCheck={false}
            autoFocus
            disabled={sending}
            aria-invalid={Boolean(errors.apiKey) || undefined}
            data-testid="key-input"
          />
          <button type="button" className={`absolute top-0.5 right-0.5 h-6 rounded-control px-2 text-muted type-caption hover:text-fg ${FOCUS}`} onClick={() => setShow((v) => !v)} aria-pressed={show} data-testid="key-show">
            {show ? C.HIDE : C.SHOW}
          </button>
        </div>
        <button type="button" className={PRIMARY} disabled={blank || sending} onClick={() => void save()} data-testid="key-save">
          {C.SAVE}
        </button>
        <button type="button" className={GHOST} onClick={onCancel} data-testid="key-cancel">
          {C.CANCEL}
        </button>
      </div>
      {errors.apiKey && <span className="text-danger type-caption">{errors.apiKey}</span>}
    </fieldset>
  );
}

/** The #74 confirm dialog: Cancel (focused first), Escape or a backdrop click keeps the key; "Delete key" (danger) deletes. */
function DeleteKeyDialog({ provider, featuresUsing, onCancel, onConfirm }: { provider: AiKeyProvider; featuresUsing: number; onCancel: () => void; onConfirm: () => void }) {
  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="delete-key-title"
        aria-describedby="delete-key-body"
        data-testid="key-delete-dialog"
        className="flex w-[440px] flex-col gap-3 rounded-card border border-line bg-card px-5 py-4 shadow-[0_12px_32px_rgba(0,0,0,.45)]"
        onKeyDown={(e) => {
          if (e.key !== "Escape") return;
          e.stopPropagation();
          onCancel();
        }}
      >
        <h2 id="delete-key-title" className="type-heading">
          {C.deleteTitle(provider)}
        </h2>
        <p id="delete-key-body" className="text-muted type-table">
          {C.deleteBody(provider, featuresUsing)}
        </p>
        <div className="flex justify-end gap-2">
          <button type="button" autoFocus onClick={onCancel} className="h-7 rounded-control border border-line px-3 text-muted type-table-strong hover:text-fg" data-testid="key-delete-cancel">
            {C.CANCEL}
          </button>
          <button type="button" onClick={onConfirm} className="h-7 rounded-control bg-(--status-off-track-dark-bg) px-3 text-danger type-table-strong" data-testid="key-delete-confirm">
            {C.DELETE}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
