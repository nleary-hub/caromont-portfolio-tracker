"use client";

import { useState } from "react";
import { AiAlert } from "@/components/AiNoteAssistant";
import type { OpenAiListState } from "@/components/useOpenAiModelList";
import { AiCopy as C } from "@/lib/ai/AiCopy";
import { AiModelKinds, type AiModelKind } from "@/lib/ai/AiModelKinds";

/** The same 2px focus outline and control styles as the rest of Admin > AI settings. */
const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const INPUT = `h-8 w-full min-w-0 rounded-control border border-line bg-input px-2.5 text-fg type-table focus:border-accent disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger ${FOCUS}`;
const GHOST = `h-7 rounded-control border border-line px-3 text-fg type-table-strong hover:border-accent disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`;

/**
 * The one model picker on Admin > AI settings (writing assistant, test connection, voice chat, dictation): a custom
 * dropdown of the models of `kind` that are on under Models, plus the ones OpenAI lists for the saved key (Show OpenAI
 * models). Models that are off are greyed out whole, with "Off under Models"; picking one is allowed, but saving or
 * testing it is refused until an admin turns it on. When the list can't load, a plain "Or type a model ID" field sits
 * under the picker; a typed ID is used just like a pick (no extra button). The load error itself is shown once, at
 * the top of the AI settings card, not here. `name` posts the choice in a form; `onChange` reports every change;
 * `onCommit` fires on a pick, and on Enter or leaving the typed field.
 */
export function ModelField({
  value,
  error,
  disabled,
  options = [],
  defaultOpen = false,
  id = "ai-model",
  name = "model",
  label = C.MODEL_LABEL,
  help = C.MODEL_HELP,
  kind = "chat",
  noneLabel,
  list = null,
  listLoading = false,
  onLoadList,
  onChange,
  onCommit,
}: {
  value: string;
  error?: string;
  disabled?: boolean;
  options?: readonly string[];
  defaultOpen?: boolean;
  id?: string;
  name?: string | null;
  label?: string;
  help?: string;
  kind?: AiModelKind;
  /** An empty first choice (for example "None") that clears the model. */
  noneLabel?: string;
  list?: OpenAiListState;
  listLoading?: boolean;
  onLoadList?: () => void;
  onChange?: (model: string) => void;
  onCommit?: (model: string) => void;
}) {
  const [model, setModel] = useState(value);
  const [open, setOpen] = useState(defaultOpen);
  const on = new Set(options);
  const listed = list?.ok ? list.models.filter((m) => m.kind === kind).map((m) => m.id) : [];
  const all = [...new Set([...(value ? [value] : []), ...options, ...listed])];
  const manual = list?.ok === false;
  const set = (m: string) => {
    setModel(m);
    onChange?.(m);
  };
  const pick = (m: string) => {
    set(m);
    setOpen(false);
    onCommit?.(m);
  };
  const commitTyped = () => {
    if (model.trim() !== value.trim()) onCommit?.(model.trim());
  };
  const listId = `${id}-list`;
  const off = (m: string) => !on.has(m) && m !== value;
  return (
    <Field id={id} label={label} error={error} help={help}>
      {name && <input type="hidden" name={name} value={model} />}
      <div className="relative">
        <button
          type="button"
          id={id}
          role="combobox"
          aria-invalid={Boolean(error) || undefined}
          className={`${INPUT} flex items-center justify-between text-left`}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={listId}
          aria-describedby={error ? `${id}-error` : `${id}-help`}
          disabled={disabled}
          onClick={() => setOpen((v) => !v)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
          }}
          data-testid={`${id}-picker`}
        >
          <span className={model ? "text-fg" : "text-muted"}>{model || noneLabel || C.MODEL_PICKER_PLACEHOLDER}</span>
          <span aria-hidden className="text-muted">▾</span>
        </button>
        {open && (
          <ul id={listId} role="listbox" aria-label={label} className="absolute z-30 mt-1 max-h-64 w-full overflow-y-auto rounded-control border border-line bg-input py-1 shadow-[0_12px_32px_rgba(0,0,0,.55)]" data-testid={`${id}-list`} onKeyDown={(e) => e.key === "Escape" && setOpen(false)}>
            {noneLabel && (
              <li role="option" aria-selected={!model}>
                <button type="button" className={`w-full px-2.5 py-1.5 text-left type-table text-muted hover:bg-input ${FOCUS}`} onClick={() => pick("")}>
                  {noneLabel}
                </button>
              </li>
            )}
            {all.length === 0 && <li className="px-2.5 py-1.5 text-muted type-caption">{C.MODEL_PICKER_EMPTY}</li>}
            {all.map((m) => (
              <li key={m} role="option" aria-selected={m === model} data-off={off(m) || undefined}>
                <button type="button" className={`flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left type-table hover:bg-input ${off(m) ? "text-muted" : m === model ? "text-accent" : "text-fg"} ${FOCUS}`} onClick={() => pick(m)}>
                  <span className="min-w-0 truncate">{m}</span>
                  {off(m) && <span className="shrink-0 type-caption">{C.MODEL_PICKER_OFF}</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {onLoadList && (
        <div className="flex items-center gap-2">
          <button type="button" className={GHOST} onClick={onLoadList} disabled={disabled || listLoading} data-testid={`${id}-load-list`}>
            {listLoading ? C.MODEL_LIST_LOADING : C.MODEL_LIST_LOAD}
          </button>
          {list?.ok && <span className="text-muted type-caption">{`${listed.length} ${AiModelKinds.label(kind).toLowerCase()} models listed`}</span>}
        </div>
      )}
      {manual && (
        <div className="flex flex-col gap-1" data-testid={`${id}-manual`}>
          <label htmlFor={`${id}-manual-input`} className="text-muted type-caption">
            {C.MODEL_PICKER_MANUAL_LABEL}
          </label>
          <input
            id={`${id}-manual-input`}
            className={INPUT}
            value={model}
            onChange={(e) => set(e.target.value)}
            onBlur={commitTyped}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitTyped();
              }
            }}
            placeholder={C.MODEL_ADD_PLACEHOLDER}
            maxLength={100}
            autoComplete="off"
            spellCheck={false}
            disabled={disabled}
          />
        </div>
      )}
    </Field>
  );
}

export function Field({ id, label, error, help, children }: { id: string; label: string; error?: string; help?: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-muted type-caption">
        {label}
      </label>
      {children}
      {/* Error: the red alert box from the editor (#50); help: the grey hint. Both carry the id the input's aria-describedby names. */}
      {error ? (
        <div id={`${id}-error`}>
          <AiAlert tone="danger" testId={`${id}-error`}>
            {error}
          </AiAlert>
        </div>
      ) : help ? (
        <p id={`${id}-help`} className="text-muted type-caption">
          {help}
        </p>
      ) : null}
    </div>
  );
}
