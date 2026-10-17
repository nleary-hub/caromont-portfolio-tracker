"use client";

import { createContext, createElement, useContext, useState, useTransition, type ReactNode } from "react";
import { listAiProviderModels } from "@/app/actions/aiAdmin";
import { PickerSelect, type PickerOption } from "@/components/PickerSelect";
import { useOpenAiModelList, type OpenAiListState } from "@/components/useOpenAiModelList";
import { AiCopy as C } from "@/lib/ai/AiCopy";
import { AiFeatureProviders, type AiFeatureProvider, type AiProviderKeyStates } from "@/lib/ai/AiFeatureProviders";

/** The same 2px focus outline and control styles as the rest of Admin > AI settings. */
const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const INPUT = `h-8 w-full min-w-0 rounded-control border border-line bg-input px-2.5 text-fg type-table focus:border-accent disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger ${FOCUS}`;

/** The Provider keys card (PR A) that the "No key" and "Key failing" hints point at. */
export const PROVIDER_KEYS_CARD_ID = "ai-provider-keys";

/** Scrolls to the Provider keys card and moves focus to it. */
export function focusProviderKeys(): void {
  const el = document.getElementById(PROVIDER_KEYS_CARD_ID);
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "start" });
  if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
  el.focus({ preventScroll: true });
}

export type ProviderLists = {
  list: (p: AiFeatureProvider) => OpenAiListState;
  loading: (p: AiFeatureProvider) => boolean;
  load: (p: AiFeatureProvider) => void;
};

const SharedLists = createContext<ProviderLists | null>(null);

function useLocalLists(initial: Partial<Record<AiFeatureProvider, OpenAiListState>>): ProviderLists {
  const openAi = useOpenAiModelList(initial.openai ?? null);
  const [lists, setLists] = useState<Partial<Record<AiFeatureProvider, OpenAiListState>>>(initial);
  const [busy, setBusy] = useState<Partial<Record<AiFeatureProvider, boolean>>>({});
  const [, start] = useTransition();
  return {
    list: (p) => (p === "openai" ? openAi.list : (lists[p] ?? null)),
    loading: (p) => (p === "openai" ? openAi.loading : Boolean(busy[p])),
    load: (p) => {
      if (p === "openai") return openAi.load();
      setBusy((b) => ({ ...b, [p]: true }));
      start(async () => {
        const r = await listAiProviderModels(p);
        setLists((l) => ({ ...l, [p]: r ?? { ok: false, error: C.providerListFailed(p) } }));
        setBusy((b) => ({ ...b, [p]: false }));
      });
    },
  };
}

/**
 * One model list per provider for the Features grid, loaded on demand (opening a row's model picker). OpenAI uses the
 * page's shared OpenAI list (#63); Anthropic, xAI and Other each load their own /v1/models once.
 */
export function ProviderModelListsProvider({ initial = {}, children }: { initial?: Partial<Record<AiFeatureProvider, OpenAiListState>>; children?: ReactNode }) {
  const value = useLocalLists(initial);
  return createElement(SharedLists.Provider, { value }, children);
}

export function useProviderModelLists(initial: Partial<Record<AiFeatureProvider, OpenAiListState>> = {}): ProviderLists {
  const shared = useContext(SharedLists);
  const local = useLocalLists(initial);
  return shared ?? local;
}

/** The Provider options: providers without a working key are greyed out with a hint that links to Provider keys. */
export function providerOptions(keyStates: AiProviderKeyStates | undefined): PickerOption[] {
  return AiFeatureProviders.ALL.map((p) => {
    const state = keyStates?.[p] ?? "ok";
    if (state === "ok") return { value: p, label: AiFeatureProviders.label(p) };
    return { value: p, label: AiFeatureProviders.label(p), disabled: true, hint: state === "failing" ? C.PROVIDER_HINT_KEY_FAILING : C.PROVIDER_HINT_NO_KEY, onHint: focusProviderKeys };
  });
}

/** The Provider picker in a text feature row (PickerSelect from #76, 140px wide). */
export function ProviderPickerCell({ feature, value, keyStates, onChange, className = "" }: { feature: string; value: AiFeatureProvider; keyStates?: AiProviderKeyStates; onChange: (p: AiFeatureProvider) => void; className?: string }) {
  return (
    <div className={`w-[140px] ${className}`}>
      <PickerSelect id={`ai-feature-${feature}-provider`} label={C.FEATURE_PROVIDER_LABEL} value={value} options={providerOptions(keyStates)} menuWidth={200} onChange={(v) => onChange(AiFeatureProviders.stored(v))} testId={`ai-feature-${feature}-provider`} />
    </div>
  );
}

/** Voice chat and Dictation: a locked OpenAI chip with a lock glyph, no dropdown. */
export function LockedProviderChip({ feature, className = "" }: { feature: string; className?: string }) {
  return (
    <span
      className={`inline-flex h-[28px] w-[140px] items-center gap-1.5 rounded-control border border-line bg-input/60 px-2 text-muted type-table ${className}`}
      aria-label={`${C.FEATURE_PROVIDER_LABEL}: OpenAI. ${C.VOICE_OPENAI_ONLY}`}
      title={C.VOICE_OPENAI_ONLY}
      data-testid={`ai-feature-${feature}-provider-locked`}
    >
      <svg aria-hidden width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" data-testid={`ai-feature-${feature}-lock`}>
        <rect x="3" y="7" width="10" height="7" rx="1.5" />
        <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
      </svg>
      <span className="text-fg">OpenAI</span>
    </span>
  );
}

/**
 * The Model picker in a text feature row: the provider's models that are on under Models plus the ones its list
 * returns (#71: off ones greyed whole with "Off under Models"). Other, or a list that failed, gets a typed-ID field
 * instead (with the models that are on as suggestions). `value` "" with no pending provider shows the AI settings model.
 */
export function TextModelCell({
  feature,
  provider,
  value,
  mainModel,
  pending,
  options,
  lists,
  disabled,
  onPick,
  className = "",
}: {
  feature: string;
  provider: AiFeatureProvider;
  value: string;
  /** The AI settings model, shown (muted) for a feature with no model of its own. */
  mainModel: string;
  /** The provider was just changed: no model yet (amber "Pick a model" in the caption). */
  pending: boolean;
  /** Models of this provider that are on under Models. */
  options: readonly string[];
  lists: ProviderLists;
  disabled?: boolean;
  onPick: (model: string) => void;
  className?: string;
}) {
  const id = `ai-feature-${feature}-model`;
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState(value);
  // Reset the typed text when the provider or saved model changes (state from props, React's documented pattern).
  const [typedFor, setTypedFor] = useState(`${provider}:${value}`);
  if (typedFor !== `${provider}:${value}`) {
    setTypedFor(`${provider}:${value}`);
    setTyped(value);
  }
  const list = lists.list(provider);
  const listed = list?.ok ? list.models.filter((m) => m.kind === "chat").map((m) => m.id) : [];
  const on = new Set(options);
  const all = [...new Set([...(value ? [value] : []), ...options, ...listed])];
  const off = (m: string) => !on.has(m);
  const typedMode = provider === "other" || list?.ok === false;
  const shown = value || (pending ? "" : mainModel);
  const inherits = !value && !pending && Boolean(mainModel);

  if (typedMode) {
    const commit = () => {
      const m = typed.trim();
      if (m && m !== value) onPick(m);
    };
    return (
      <div className={`min-w-0 ${className}`} data-testid={`${id}-typed`}>
        <label htmlFor={`${id}-typed-input`} className="sr-only">
          {C.FEATURE_MODEL_LABEL}
        </label>
        <input
          id={`${id}-typed-input`}
          className={INPUT}
          value={typed}
          list={`${id}-suggestions`}
          onChange={(e) => setTyped(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            }
          }}
          placeholder={inherits ? mainModel : C.FEATURE_MODEL_TYPE_PLACEHOLDER}
          maxLength={100}
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          data-testid={`${id}-typed-input`}
        />
        <datalist id={`${id}-suggestions`}>
          {options.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
      </div>
    );
  }

  const listId = `${id}-list`;
  return (
    <div className={`relative min-w-0 ${className}`}>
      <button
        type="button"
        id={id}
        role="combobox"
        aria-label={C.FEATURE_MODEL_LABEL}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        title={inherits ? C.FEATURE_MODEL_SAME_AS_ABOVE : undefined}
        className={`${INPUT} flex items-center justify-between gap-2 text-left`}
        disabled={disabled}
        onClick={() => {
          if (!open && !list && !lists.loading(provider)) lists.load(provider);
          setOpen((v) => !v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
        data-testid={`${id}-picker`}
        data-inherits={inherits || undefined}
      >
        <span className={`min-w-0 truncate ${value ? "text-fg" : "text-muted"}`}>{shown || C.MODEL_PICKER_PLACEHOLDER}</span>
        <span aria-hidden className="text-muted">
          ▾
        </span>
      </button>
      {open && (
        <ul id={listId} role="listbox" aria-label={C.FEATURE_MODEL_LABEL} className="absolute z-30 mt-1 max-h-64 w-full min-w-[220px] overflow-y-auto rounded-control border border-line bg-input py-1 shadow-[0_12px_32px_rgba(0,0,0,.55)]" data-testid={listId} onKeyDown={(e) => e.key === "Escape" && setOpen(false)}>
          {lists.loading(provider) && <li className="px-2.5 py-1.5 text-muted type-caption">{C.MODEL_LIST_LOADING}</li>}
          {all.length === 0 && !lists.loading(provider) && <li className="px-2.5 py-1.5 text-muted type-caption">{C.MODEL_PICKER_EMPTY}</li>}
          {all.map((m) => (
            <li key={m} role="option" aria-selected={m === value} data-off={off(m) || undefined}>
              <button
                type="button"
                className={`flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left type-table hover:bg-input ${off(m) ? "text-muted" : m === value ? "text-accent" : "text-fg"} ${FOCUS}`}
                onClick={() => {
                  setOpen(false);
                  if (m !== value || pending) onPick(m);
                }}
                data-testid={`${id}-option-${m}`}
              >
                <span className="min-w-0 truncate">{m}</span>
                {off(m) && <span className="shrink-0 type-caption">{C.MODEL_PICKER_OFF}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
