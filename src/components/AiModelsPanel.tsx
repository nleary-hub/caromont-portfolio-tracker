"use client";

import { useState, useTransition } from "react";
import { usePriceReviewLock } from "@/components/AiPriceReviewLock";
import { addAiModel, setAiFeatureEnabled, setAiFeatureModel, setAiFeatureProvider, setAiModelEnabled, setAiModelPrices, setAiVoiceInstructions, setAiVoiceSessionCap } from "@/app/actions/aiAdmin";
import { LockedProviderChip, ProviderPickerCell, TextModelCell, textModelCaption, useProviderModelLists } from "@/components/AiFeatureProviderPicker";
import { AiFeatureProviders, type AiFeatureProvider, type AiProviderKeyStates } from "@/lib/ai/AiFeatureProviders";
import { ModelField } from "@/components/AiModelPicker";
import { AiAlert } from "@/components/AiNoteAssistant";
import { AiCopy as C } from "@/lib/ai/AiCopy";
import { AiModelDefaults } from "@/lib/ai/AiModelDefaults";
import { AiModelKinds, type AiModelKind } from "@/lib/ai/AiModelKinds";
import { AiToolsCopy } from "@/lib/ai/AiToolsCopy";
import { AiVoiceChat } from "@/lib/ai/AiVoiceChat";
import { useOpenAiModelList, type OpenAiListState } from "@/components/useOpenAiModelList";
import type { AiAdminResult, AiFeatureChoice, AiFeatureView, AiModelView } from "@/lib/services/AiModelService";

/** Item D: a seeded default that is not running, and the AI settings model used instead. */
export type AiModelFallback = { seeded: string; using: string; reason: "model_off" | "no_key" };

/** The same 2px focus outline used across the AI settings page since #50. */
const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const INPUT = `h-8 w-full min-w-0 rounded-control border border-line bg-input px-2.5 text-fg type-table focus:border-accent disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-invalid:border-danger ${FOCUS}`;
/** Price inputs: fixed width so 4 decimals (0.0500) always fit. */
const PRICE_INPUT = `${INPUT.replace("w-full min-w-0 ", "")} w-[6.5rem] min-w-[6.5rem] tabular-nums`;
const GHOST = `h-7 whitespace-nowrap rounded-control border border-line px-3 text-fg type-table-strong hover:border-accent disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:border-line ${FOCUS}`;
/** Secondary: no glow (only the settings Save, the primary button, glows). */
const SECONDARY = `h-8 whitespace-nowrap rounded-control border border-line px-3.5 text-fg type-table-strong hover:border-accent disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`;

/** "Prices updated" date under each model name (step 3c), in ET like the rest of the page. */
const PRICE_DATE = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "America/New_York" });

/** On/off switch (.acct-switch carries the 2px focus-visible outline). */
export function AiToggle({ checked, onChange, labelledBy, describedBy, disabled, locked, testId }: { checked: boolean; onChange: (v: boolean) => void; labelledBy: string; describedBy?: string; disabled?: boolean; locked?: boolean; testId: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-labelledby={labelledBy} aria-describedby={describedBy} aria-disabled={locked || undefined} onClick={() => !locked && onChange(!checked)} disabled={disabled} className="acct-switch mt-0.5 disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50" data-testid={testId}>
      <span aria-hidden className="acct-thumb" />
    </button>
  );
}

/** Admin > AI settings: the model list (add, on/off with the in-use warning, prices). */
export function AiModelsPanel({ models, dbReady, initialList = null, keyStates }: { models: AiModelView[]; dbReady: boolean; initialList?: OpenAiListState; keyStates?: AiProviderKeyStates }) {
  const [newId, setNewId] = useState("");
  /** PR B: the provider a typed model is added under (checked against that provider's list). OpenAI by default. */
  const [addProvider, setAddProvider] = useState<AiFeatureProvider>("openai");
  const lists = useProviderModelLists();
  const { list, loading: listing, load: loadList, shared } = useOpenAiModelList(initialList);
  /** The list failed to load: the typed id is saved unchecked (still off), with the note shown. */
  const manual = list?.ok === false;
  const [addResult, setAddResult] = useState<AiAdminResult | null>(null);
  const [adding, startAdd] = useTransition();
  const [pending, startToggle] = useTransition();
  const [confirm, setConfirm] = useState<{ id: string; message: string } | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  const locked = usePriceReviewLock();

  const toggle = (id: string, enabled: boolean, confirmed: boolean) =>
    startToggle(async () => {
      const r = await setAiModelEnabled(id, enabled, confirmed);
      if (r.ok) {
        setConfirm(null);
        setRowError(null);
      } else if (r.needsConfirm) setConfirm({ id, message: r.error });
      else setRowError({ id, message: r.error });
    });

  return (
    <div className="flex flex-col gap-3" data-testid="ai-models">
      <div className="overflow-x-auto rounded-card border border-line" data-locked={locked || undefined} data-testid="ai-models-table">
        <table className="w-full type-table">
          <thead className="bg-card text-left text-muted type-label">
            <tr>
              {C.MODELS_HEADERS.map((h, i) => (
                <th key={i} className="px-3 py-2 font-medium">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {models.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-4 text-center text-muted">
                  {C.MODELS_EMPTY}
                </td>
              </tr>
            )}
            {models.map((m) => (
              <ModelRow key={m.id} m={m} locked={locked} dbReady={dbReady} pending={pending} onToggle={(v) => toggle(m.id, v, false)} confirm={confirm?.id === m.id ? confirm.message : null} error={rowError?.id === m.id ? rowError.message : null} onConfirm={() => toggle(m.id, false, true)} onCancel={() => setConfirm(null)} />
            ))}
          </tbody>
        </table>
      </div>

      <OpenAiModelList
        state={list}
        loading={listing}
        disabled={!dbReady || locked}
        have={new Set(models.map((m) => m.id))}
        onLoad={loadList}
        sharedError={shared}
        onAdd={(id) =>
          startAdd(async () => {
            const r = await addAiModel(id);
            setAddResult(r);
          })
        }
      />

      <form
        className="flex flex-col gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          // Locked while a price-refresh review is open (step 3c follow-up): the form does nothing until Cancel or Confirm.
          if (locked) return;
          startAdd(async () => {
            const r = addProvider === "openai" ? await addAiModel(newId, manual) : await addAiModel(newId, lists.list(addProvider)?.ok === false, addProvider);
            setAddResult(r);
            if (r.ok) setNewId("");
          });
        }}
        data-testid="ai-model-add"
        data-locked={locked || undefined}
      >
        <label htmlFor="ai-model-add" className="text-muted type-caption">
          {addProvider === "openai" ? C.MODEL_ADD_LABEL : C.modelAddLabel(addProvider)}
        </label>
        <div className="flex items-start gap-2">
          {keyStates && <ProviderPickerCell feature="add" value={addProvider} keyStates={keyStates} onChange={(p) => { setAddProvider(p); setAddResult(null); }} />}
          <input id="ai-model-add" className={INPUT} value={newId} onChange={(e) => setNewId(e.target.value)} placeholder={C.MODEL_ADD_PLACEHOLDER} maxLength={100} autoComplete="off" spellCheck={false} disabled={!dbReady} readOnly={locked} aria-disabled={locked || undefined} aria-invalid={(addResult && !addResult.ok) || undefined} aria-describedby={addResult && !addResult.ok ? "ai-model-add-error" : "ai-model-add-help"} />
          <button type="submit" className={`${SECONDARY} aria-disabled:cursor-not-allowed aria-disabled:opacity-50`} disabled={!dbReady || adding || !newId.trim()} aria-disabled={locked || undefined} data-testid="ai-model-add-button">
            {adding ? C.MODEL_ADDING : C.MODEL_ADD}
          </button>
        </div>
        {addResult && !addResult.ok ? (
          <div id="ai-model-add-error">
            <AiAlert tone="danger" testId="ai-model-add-error">
              {addResult.error}
            </AiAlert>
          </div>
        ) : addResult?.ok ? (
          <p role="status" className="text-(--status-on-track-dark-fg) type-table" data-testid="ai-model-add-ok">
            {addResult.message}
          </p>
        ) : (
          <p id="ai-model-add-help" className="text-muted type-caption">
            {manual ? C.MODEL_ADD_MANUAL_HELP : C.MODEL_ADD_HELP}
          </p>
        )}
      </form>
    </div>
  );
}

export type { OpenAiListState };

/**
 * OpenAI's model list for the saved key, by type. Adding one saves it off; nothing is turned on here. When the list
 * can't load, the note says so and the Add box below saves the typed id without the check.
 */
export function OpenAiModelList({ state, loading, disabled, have, onLoad, onAdd, sharedError = false }: { state: OpenAiListState; loading: boolean; disabled: boolean; have: ReadonlySet<string>; onLoad: () => void; onAdd: (id: string) => void; sharedError?: boolean }) {
  return (
    <div className="flex flex-col gap-2" data-testid="ai-openai-list">
      <div className="flex items-center gap-3">
        <button type="button" className={SECONDARY} onClick={onLoad} disabled={disabled || loading} data-testid="ai-openai-list-load">
          {loading ? C.MODEL_LIST_LOADING : C.MODEL_LIST_LOAD}
        </button>
        <span className="text-muted type-caption">{C.MODEL_LIST_HELP}</span>
      </div>
      {state && !state.ok && !sharedError && (
        <div id="ai-openai-list-error">
          <AiAlert tone="danger" testId="ai-openai-list-failed">
            {C.MODEL_PICKER_LIST_FAILED}
          </AiAlert>
        </div>
      )}
      {state?.ok && state.models.length === 0 && <p className="text-muted type-caption">{C.MODEL_LIST_EMPTY}</p>}
      {state?.ok && state.models.length > 0 && (
        <ul className="max-h-64 overflow-y-auto rounded-card border border-line" aria-label={C.MODEL_LIST_LOAD} data-testid="ai-openai-list-rows">
          {state.models.map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-3 border-b border-line px-3 py-1.5 last:border-b-0">
              <span className="min-w-0 truncate type-table text-fg">{m.id}</span>
              <span className="ml-auto text-muted type-caption">{AiModelKinds.label(m.kind)}</span>
              {have.has(m.id) ? (
                <span className="w-[5.5rem] text-right text-muted type-caption">{C.MODEL_LIST_ADDED}</span>
              ) : (
                <button type="button" className={`${GHOST} w-[5.5rem]`} disabled={disabled} onClick={() => onAdd(m.id)} aria-label={`${C.MODEL_ADD}: ${m.id}`}>
                  {C.MODEL_ADD}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ModelRow({ m, locked, dbReady, pending, onToggle, confirm, error, onConfirm, onCancel }: { m: AiModelView; locked: boolean; dbReady: boolean; pending: boolean; onToggle: (v: boolean) => void; confirm: string | null; error: string | null; onConfirm: () => void; onCancel: () => void }) {
  const [unit, setUnit] = useState(m.priceUnit ?? "");
  const [input, setInput] = useState(m.inputPrice);
  const [output, setOutput] = useState(m.outputPrice);
  const [saved, setSaved] = useState<AiAdminResult | null>(null);
  const [saving, startSave] = useTransition();
  const slug = m.id.replace(/[^A-Za-z0-9_-]/g, "_");
  const nameId = `ai-model-${slug}-name`;
  const priceErrorId = `ai-model-${slug}-price-error`;
  const bad = saved && !saved.ok ? (saved.field ?? null) : null;
  /** While the price-refresh review is open: aria-disabled, and edits and saves do nothing (step 3c). */
  const lock = locked ? { "aria-disabled": true as const } : {};
  const edit = (set: (v: string) => void) => (e: { target: { value: string } }) => {
    if (!locked) set(e.target.value);
  };
  /** On blur a valid price is shown with 4 decimals, like the saved ones (3c follow-up). Invalid text is left as typed. */
  const tidy = (v: string, set: (v: string) => void) => () => {
    if (!locked && /^\$?\d+(\.\d{1,4})?$/.test(v.trim())) set(Number(v.trim().replace(/^\$/, "")).toFixed(4));
  };
  const invalid = (f: "input" | "output" | "unit") => (bad === f ? { "aria-invalid": true as const, "aria-describedby": priceErrorId } : {});
  return (
    <>
      <tr className="border-t border-line" data-testid={`ai-model-row-${m.id}`}>
        <td className="px-3 py-2 whitespace-nowrap">
          <span id={nameId} className="type-table-strong text-fg">
            {m.id}
          </span>
          {m.inUse &&
            (m.enabled ? (
              <span className="ml-2 rounded-pill bg-(--status-on-track-dark-bg) px-2 py-px text-(--status-on-track-dark-fg) type-label" data-testid="ai-model-in-use">
                {C.MODEL_IN_USE}
              </span>
            ) : (
              <span className="ml-2 rounded-pill bg-(--status-not-started-dark-bg) px-2 py-px text-(--status-not-started-dark-fg) type-label" data-testid="ai-model-chosen-off">
                {C.MODEL_CHOSEN_OFF}
              </span>
            ))}
          <span className="block text-muted type-caption" data-testid={`ai-model-kind-${m.id}`}>
            {C.MODEL_KIND_LABEL}: {AiModelKinds.label(m.kind ?? null)}
            {m.provider && m.provider !== "openai" ? ` (${AiFeatureProviders.label(m.provider)})` : ""}
          </span>
          <span className="block whitespace-normal text-muted type-caption" data-testid={`ai-model-price-updated-${m.id}`}>
            {m.pricesUpdatedAt ? C.priceUpdated(PRICE_DATE.format(new Date(m.pricesUpdatedAt)), m.priceSource) : C.PRICE_NEVER_UPDATED}
          </span>
        </td>
        <td className="px-3 py-2">
          <AiToggle checked={m.enabled} onChange={onToggle} labelledBy={nameId} disabled={!dbReady || pending} locked={locked} testId={`ai-model-toggle-${m.id}`} />
        </td>
        <td className="px-3 py-2">
          <select aria-label={`${C.MODELS_HEADERS[2]}, ${m.id}`} className={`${INPUT} min-w-[8.5rem]`} value={unit} onChange={edit(setUnit)} disabled={!dbReady} {...lock} {...invalid("unit")}>
            <option value="">{C.PRICE_UNIT_NONE}</option>
            <option value="per_1m_tokens">{C.PRICE_UNIT_PER_1M_TOKENS}</option>
            <option value="per_minute">{C.PRICE_UNIT_PER_MINUTE}</option>
          </select>
        </td>
        <td className="px-3 py-2">
          <input aria-label={`${C.MODELS_HEADERS[3]}, ${m.id}`} className={`${PRICE_INPUT}`} value={input} onChange={edit(setInput)} onBlur={tidy(input, setInput)} readOnly={locked} {...lock} inputMode="decimal" placeholder="0.0000" disabled={!dbReady} {...invalid("input")} data-testid={`ai-model-input-price-${m.id}`} />
        </td>
        <td className="px-3 py-2">
          <input aria-label={`${C.MODELS_HEADERS[4]}, ${m.id}`} className={`${PRICE_INPUT}`} value={output} onChange={edit(setOutput)} onBlur={tidy(output, setOutput)} readOnly={locked} {...lock} inputMode="decimal" placeholder="0.0000" disabled={!dbReady || unit === "per_minute"} {...invalid("output")} data-testid={`ai-model-output-price-${m.id}`} />
        </td>
        <td className="px-3 py-2">
          <button type="button" className={GHOST} disabled={!dbReady || saving} {...lock} data-testid={`ai-model-save-${m.id}`} onClick={() => !locked && startSave(async () => setSaved(await setAiModelPrices(m.id, unit, input, unit === "per_minute" ? "" : output)))}>
            {C.PRICE_SAVE}
          </button>
        </td>
      </tr>
      {(confirm || error || saved) && (
        <tr>
          <td colSpan={6} className="px-3 pb-2">
            {confirm ? (
              <div className="flex items-center gap-2 rounded-control bg-(--status-off-track-dark-bg) px-3 py-2" role="alert" data-testid="ai-model-disable-warning">
                <span className="min-w-0 flex-1 text-fg type-table">{confirm}</span>
                <button type="button" className={`h-7 rounded-control border border-line px-2.5 text-fg type-table-strong hover:border-accent ${FOCUS}`} onClick={onCancel} data-testid="ai-model-disable-cancel">
                  {C.DISABLE_CONFIRM_NO}
                </button>
                <button type="button" className={`h-7 rounded-control bg-(--status-off-track-dark-bg) px-2.5 text-danger type-table-strong ring-1 ring-danger/40 ${FOCUS}`} onClick={onConfirm} disabled={pending} data-testid="ai-model-disable-confirm">
                  {C.DISABLE_CONFIRM_YES}
                </button>
              </div>
            ) : error ? (
              <AiAlert tone="danger" testId="ai-model-row-error">
                {error}
              </AiAlert>
            ) : saved && !saved.ok ? (
              <div id={priceErrorId}>
                <AiAlert tone="danger" testId="ai-model-price-error">
                  {saved.error}
                </AiAlert>
              </div>
            ) : (
              <p role="status" className="text-(--status-on-track-dark-fg) type-table">
                {saved?.ok ? (saved.message ?? C.PRICES_SAVED) : null}
              </p>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

/** Voice and command bar item: the voice chat session limit in minutes (admin only; checked on the server, 0060). */
function VoiceSessionCapField({ initialSeconds, disabled }: { initialSeconds: number; disabled: boolean }) {
  const [text, setText] = useState(String(Math.round(initialSeconds / 60)));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, start] = useTransition();
  return (
    <div className="col-start-1 flex min-w-0 flex-col gap-1 pt-2" data-testid="ai-voice-cap">
      <label htmlFor="ai-voice-cap-input" className="text-muted type-caption">
        {C.VOICE_CAP_LABEL}
      </label>
      <div className="flex items-center gap-2">
        <input
          id="ai-voice-cap-input"
          inputMode="numeric"
          value={text}
          maxLength={2}
          onChange={(e) => {
            setText(e.target.value);
            setMsg(null);
          }}
          aria-describedby="ai-voice-cap-help"
          aria-invalid={(msg && !msg.ok) || undefined}
          disabled={disabled || saving}
          className="h-7 w-16 rounded-control border border-line bg-input px-2.5 text-fg tabular-nums type-table focus:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent aria-invalid:border-danger disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="ai-voice-cap-input"
        />
        <button
          type="button"
          className="h-7 rounded-control border border-line px-3 text-fg type-table-strong hover:border-accent disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          disabled={disabled || saving}
          onClick={() =>
            start(async () => {
              const r = await setAiVoiceSessionCap(text);
              setMsg(r?.ok ? { ok: true, text: r.message ?? C.VOICE_CAP_SAVED } : { ok: false, text: r?.error ?? C.SAVE_FAILED });
            })
          }
          data-testid="ai-voice-cap-save"
        >
          {C.VOICE_CAP_SAVE}
        </button>
        {msg?.ok && (
          <span role="status" className="text-muted type-caption">
            {msg.text}
          </span>
        )}
      </div>
      <p id="ai-voice-cap-help" className="text-muted type-caption">
        {C.VOICE_CAP_HELP}
      </p>
      {msg && !msg.ok && <AiAlert tone="danger" testId="ai-voice-cap-error">{msg.text}</AiAlert>}
    </div>
  );
}

/**
 * Voice chat instructions (admin only). Empty by default (the built-in rules); the server checks the length and always
 * adds the project list, the suggest-changes rule and the patient-details rule.
 */
function VoiceInstructionsField({ initial, disabled }: { initial: string; disabled: boolean }) {
  const [text, setText] = useState(initial);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, start] = useTransition();
  const count = text.trim().length;
  const over = count > AiVoiceChat.INSTRUCTIONS_MAX;
  // 4 rows tall to start, grows with the text up to 6 rows, then scrolls.
  const grow = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    const cs = getComputedStyle(el);
    const line = parseFloat(cs.lineHeight) || 20;
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const borderY = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    el.style.height = "auto";
    const content = Math.min(Math.max(el.scrollHeight - padY, line * 4), line * 6);
    el.style.height = `${content + padY + borderY}px`;
  };
  return (
    <div className="col-start-1 flex min-w-0 flex-col gap-1" data-testid="ai-voice-instructions">
      <label htmlFor="ai-voice-instructions-input" className="text-muted type-caption">
        {C.VOICE_INSTRUCTIONS_LABEL}
      </label>
      <textarea
        id="ai-voice-instructions-input"
        ref={grow}
        rows={4}
        className="w-full min-w-0 resize-none overflow-y-auto rounded-control border border-line bg-input px-2.5 py-1.5 text-fg type-table focus:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent aria-invalid:border-danger disabled:cursor-not-allowed disabled:opacity-50"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setMsg(null);
          grow(e.target);
        }}
        aria-invalid={over || undefined}
        aria-describedby="ai-voice-instructions-help ai-voice-instructions-count"
        disabled={disabled || saving}
        data-testid="ai-voice-instructions-input"
      />
      <div className="flex items-start justify-between gap-3">
        <p id="ai-voice-instructions-help" className="text-muted type-caption">
          {C.VOICE_INSTRUCTIONS_HELP}
        </p>
        <span id="ai-voice-instructions-count" className={`shrink-0 tabular-nums type-caption ${over ? "text-danger" : "text-muted"}`} data-testid="ai-voice-instructions-count">
          {`${count.toLocaleString("en-US")} / ${AiVoiceChat.INSTRUCTIONS_MAX.toLocaleString("en-US")}`}
        </span>
      </div>
      {over && <AiAlert tone="danger" testId="ai-voice-instructions-over">{C.VOICE_INSTRUCTIONS_TOO_LONG}</AiAlert>}
      {msg && !msg.ok && <AiAlert tone="danger" testId="ai-voice-instructions-error">{msg.text}</AiAlert>}
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="h-7 rounded-control border border-line px-3 text-fg type-table-strong hover:border-accent disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          disabled={disabled || saving || over}
          onClick={() =>
            start(async () => {
              const r = await setAiVoiceInstructions(text);
              setMsg(r?.ok ? { ok: true, text: r.message ?? C.VOICE_INSTRUCTIONS_SAVED } : { ok: false, text: r?.error ?? C.SAVE_FAILED });
            })
          }
          data-testid="ai-voice-instructions-save"
        >
          {C.VOICE_INSTRUCTIONS_SAVE}
        </button>
        {msg?.ok && (
          <span role="status" className="text-muted type-caption">
            {msg.text}
          </span>
        )}
      </div>
    </div>
  );
}

/** A copy of `o` without `key`. */
function without<T>(o: Partial<Record<string, T>>, key: string): Partial<Record<string, T>> {
  return Object.fromEntries(Object.entries(o).filter(([k]) => k !== key)) as Partial<Record<string, T>>;
}

/** Admin > AI settings: one toggle per AI feature. Future features (dictation, voice chat) add a row by adding a feature. */
/**
 * `modelOptions`: enabled model ids by kind. Each own-model feature lists only its kind (dictation transcription, voice
 * chat realtime), plus the models of that kind OpenAI lists for the saved key (the same list as the Models panel). Listed
 * models that are off say so; the server refuses them until an admin turns them on. When the list can't load, a typed
 * model ID is the fallback. No built-in voice or dictation model.
 *
 * PR B: one grid of 44px rows (feature, Provider, Model, toggle). Text features pick a provider (`keyStates` greys out
 * the ones without a working key) and a model of that provider (`chatModels`: models on under Models, by provider).
 * Changing the provider clears the model and nothing is saved until a model is picked. Voice chat and Dictation show a
 * locked OpenAI chip. `choices` are the saved picks; `mainModel` is the AI settings model the rest still use.
 */
export function AiFeaturesPanel({
  features,
  dbReady,
  modelOptions = {},
  initialList = null,
  choices = {},
  keyStates,
  chatModels = {},
  mainModel = "",
  fallbacks = {},
  defaults = {},
}: {
  features: AiFeatureView[];
  dbReady: boolean;
  modelOptions?: Partial<Record<AiModelKind, readonly string[]>>;
  initialList?: OpenAiListState;
  choices?: Partial<Record<string, AiFeatureChoice>>;
  keyStates?: AiProviderKeyStates;
  chatModels?: Partial<Record<AiFeatureProvider, readonly string[]>>;
  mainModel?: string;
  /** Item D: features whose seeded default can't run now, with the AI settings model they use instead. */
  fallbacks?: Partial<Record<string, AiModelFallback>>;
  /** Item D: each feature's seeded default model (0059 defaultModel), for the "Recommended default" caption. */
  defaults?: Partial<Record<string, string>>;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const openAi = useOpenAiModelList(initialList);
  const lists = useProviderModelLists();
  const [saved, setSaved] = useState<Partial<Record<string, AiFeatureChoice>>>(choices);
  /** A provider picked but no model yet: shown, not saved. */
  const [draft, setDraft] = useState<Partial<Record<string, AiFeatureProvider>>>({});
  const choose = (feature: string, model: string) =>
    start(async () => {
      const r = await setAiFeatureModel(feature, model);
      setError(r.ok ? null : r.error);
    });
  const saveText = (feature: string, provider: AiFeatureProvider, model: string) =>
    start(async () => {
      const r = await setAiFeatureProvider(feature, provider, model);
      if (r?.ok) {
        setSaved((s) => ({ ...s, [feature]: { provider, model } }));
        setDraft((d) => without(d, feature));
        setError(null);
      } else setError(r?.error ?? C.SAVE_FAILED);
    });
  // Each list that failed is said once, above the grid (OpenAI's is said at the top of the AI settings card).
  const failed = AiFeatureProviders.ALL.filter((p) => p !== "openai" && lists.list(p)?.ok === false);
  // Fixed Provider, Model and toggle tracks, so every row lines up as one grid and the wide help or instructions under
  // the Voice chat and Dictation rows can never squeeze the label column.
  const ROW = "grid grid-cols-[minmax(0,1fr)_140px_220px_32px] items-center gap-x-3 px-3";
  return (
    <div className="flex flex-col gap-2" data-testid="ai-features">
      {failed.map((p) => (
        <AiAlert key={p} tone="danger" testId={`ai-provider-list-failed-${p}`}>
          {C.providerListFailed(p)}
        </AiAlert>
      ))}
      <div className="flex flex-col rounded-control border border-line bg-input/60" data-testid="ai-features-grid">
      {features.map((f, i) => {
        const labelId = `ai-feature-${f.feature}-label`;
        const helpId = `ai-feature-${f.feature}-help`;
        const text = AiFeatureProviders.isText(f.feature);
        const choice = saved[f.feature] ?? { provider: AiFeatureProviders.DEFAULT, model: "" };
        const shownProvider = draft[f.feature] ?? choice.provider;
        const picking = text && draft[f.feature] !== undefined;
        const keyMissing = text && !picking && keyStates !== undefined && keyStates[choice.provider] !== "ok";
        const caption = f.killedByEnv ? C.featureKilled(f.envName) : picking ? C.PICK_A_MODEL : !text ? C.VOICE_OPENAI_ONLY : f.enabled ? C.FEATURE_ON_HELP : C.FEATURE_OFF_HELP;
        return (
          <div key={f.feature} className={`${ROW} ${i > 0 ? "border-t border-line" : ""} ${f.ownModel ? "pb-2.5" : ""}`} data-testid={`ai-feature-row-${f.feature}`} data-provider={text ? shownProvider : "openai"}>
            <div className="col-start-1 row-start-1 flex h-11 min-w-0 flex-col justify-center">
              <div className="flex min-w-0 items-center gap-2">
                <span id={labelId} className="min-w-0 truncate type-table-strong text-fg">
                  {f.label}
                </span>
                {keyMissing && (
                  <span className="shrink-0 rounded-pill bg-(--status-at-risk-dark-bg) px-1.5 text-(--status-at-risk-dark-fg) type-caption" title={C.PROVIDER_KEY_MISSING_HELP} data-testid={`ai-feature-${f.feature}-key-missing`}>
                    {C.PROVIDER_KEY_MISSING}
                  </span>
                )}
              </div>
              <p id={helpId} className={`truncate type-caption ${picking ? "text-(--status-at-risk-dark-fg)" : "text-muted"}`} title={caption} data-testid={`ai-feature-${f.feature}-caption`}>
                {caption}
              </p>
            </div>
            {text ? (
              <ProviderPickerCell
                className="col-start-2 row-start-1"
                feature={f.feature}
                value={shownProvider}
                keyStates={keyStates}
                onChange={(p) => setDraft((d) => {
                  // Back to the saved provider: nothing pending. Another provider: the model is cleared until one is picked.
                  return p === choice.provider ? without(d, f.feature) : { ...d, [f.feature]: p };
                })}
              />
            ) : (
              <LockedProviderChip className="col-start-2 row-start-1" feature={f.feature} />
            )}
            {text && (() => {
              // Under the Model picker: "Default" when the row uses the AI settings model (shown at full strength), or
              // "Off under Models" when the model it would call is off (Figma Bro, Oct 17).
              // Item D: a seeded default says so, and when it can't run the row names the model used instead.
              const fb = !picking && choice.model && fallbacks[f.feature]?.seeded === choice.model ? fallbacks[f.feature] : undefined;
              const seeded = !picking && shownProvider === "openai" && AiModelDefaults.isSeeded({ model: choice.model, defaultModel: defaults[f.feature] });
              const base = textModelCaption({ value: picking ? "" : choice.model, mainModel: shownProvider === "openai" ? mainModel : "", pending: picking, options: chatModels[shownProvider] ?? [] });
              const cap = fb ? "fallback" : seeded && base === null ? "recommended" : base;
              const words = cap === "fallback" ? C.modelFallback(fb!.reason, fb!.using) : cap === "recommended" ? C.FEATURE_MODEL_RECOMMENDED : cap === "default" ? C.FEATURE_MODEL_DEFAULT : C.MODEL_PICKER_OFF;
              return cap ? (
                <p className={`col-start-3 row-start-2 -mt-1.5 min-w-0 whitespace-normal pb-1.5 pl-2 type-caption [overflow-wrap:anywhere] ${cap === "fallback" ? "text-(--status-at-risk-dark-fg)" : "text-muted"}`} title={words} data-testid={`ai-feature-${f.feature}-model-caption`} data-caption={cap}>
                  {words}
                </p>
              ) : null;
            })()}
            {text ? (
              <TextModelCell
                key={`${f.feature}-${shownProvider}`}
                className="col-start-3 row-start-1"
                feature={f.feature}
                provider={shownProvider}
                value={picking ? "" : choice.model}
                mainModel={shownProvider === "openai" ? mainModel : ""}
                pending={picking}
                options={chatModels[shownProvider] ?? []}
                lists={lists}
                disabled={!dbReady || pending}
                onPick={(m) => saveText(f.feature, shownProvider, m)}
              />
            ) : f.ownModel ? (
              <ModelField
                id={`ai-feature-${f.feature}-model`}
                name={null}
                label={AiToolsCopy.modelLabel(f.feature)}
                help={AiToolsCopy.modelHelp(f.feature)}
                kind={AiModelKinds.forFeature(f.feature)}
                {...(f.feature === "voice_chat" ? { placeholder: C.VOICE_MODEL_PLACEHOLDER } : {})}
                noneLabel={AiToolsCopy.DICTATION_MODEL_NONE}
                value={f.model ?? ""}
                disabled={!dbReady || pending}
                options={modelOptions[AiModelKinds.forFeature(f.feature)] ?? []}
                list={openAi.list}
                listLoading={openAi.loading}
                onLoadList={openAi.load}
                onCommit={(m) => choose(f.feature, m)}
                row={{ trigger: "col-start-3 row-start-1", extras: "col-start-2 col-span-3 row-start-2" }}
              />
            ) : (
              <span className="col-start-3 row-start-1" />
            )}
            <div className="col-start-4 row-start-1 flex items-center">
              <AiToggle checked={f.enabled} labelledBy={labelId} describedBy={helpId} disabled={!dbReady || pending} testId={`ai-feature-toggle-${f.feature}`} onChange={(v) => start(async () => {
                const r = await setAiFeatureEnabled(f.feature, v);
                setError(r.ok ? null : r.error);
              })} />
            </div>
            {/* Under the Voice model field's help, in the same column. */}
            {f.feature === "voice_chat" && (
              <div className="col-start-2 col-span-3 row-start-3 min-w-0 pt-2">
                <VoiceInstructionsField initial={f.instructions ?? ""} disabled={!dbReady || pending} />
                <VoiceSessionCapField initialSeconds={f.maxSessionSeconds ?? AiVoiceChat.MAX_SESSION_S} disabled={!dbReady || pending} />
              </div>
            )}
          </div>
        );
      })}
      </div>
      {error && (
        <AiAlert tone="danger" testId="ai-feature-error">
          {error}
        </AiAlert>
      )}
    </div>
  );
}
