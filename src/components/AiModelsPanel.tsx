"use client";

import { useState, useTransition } from "react";
import { usePriceReviewLock } from "@/components/AiPriceReviewLock";
import { addAiModel, setAiFeatureEnabled, setAiModelEnabled, setAiModelPrices } from "@/app/actions/aiAdmin";
import { AiAlert } from "@/components/AiNoteAssistant";
import { AiCopy as C } from "@/lib/ai/AiCopy";
import type { AiAdminResult, AiFeatureView, AiModelView } from "@/lib/services/AiModelService";

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
export function AiModelsPanel({ models, dbReady }: { models: AiModelView[]; dbReady: boolean }) {
  const [newId, setNewId] = useState("");
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

      <form
        className="flex flex-col gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          startAdd(async () => {
            const r = await addAiModel(newId);
            setAddResult(r);
            if (r.ok) setNewId("");
          });
        }}
        data-testid="ai-model-add"
      >
        <label htmlFor="ai-model-add" className="text-muted type-caption">
          {C.MODEL_ADD_LABEL}
        </label>
        <div className="flex items-start gap-2">
          <input id="ai-model-add" className={INPUT} value={newId} onChange={(e) => setNewId(e.target.value)} placeholder={C.MODEL_ADD_PLACEHOLDER} maxLength={100} autoComplete="off" spellCheck={false} disabled={!dbReady} aria-invalid={(addResult && !addResult.ok) || undefined} aria-describedby={addResult && !addResult.ok ? "ai-model-add-error" : "ai-model-add-help"} />
          <button type="submit" className={SECONDARY} disabled={!dbReady || adding || !newId.trim()} data-testid="ai-model-add-button">
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
            {C.MODEL_ADD_HELP}
          </p>
        )}
      </form>
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
          <input aria-label={`${C.MODELS_HEADERS[3]}, ${m.id}`} className={`${PRICE_INPUT}`} value={input} onChange={edit(setInput)} readOnly={locked} {...lock} inputMode="decimal" placeholder="0.00" disabled={!dbReady} {...invalid("input")} data-testid={`ai-model-input-price-${m.id}`} />
        </td>
        <td className="px-3 py-2">
          <input aria-label={`${C.MODELS_HEADERS[4]}, ${m.id}`} className={`${PRICE_INPUT}`} value={output} onChange={edit(setOutput)} readOnly={locked} {...lock} inputMode="decimal" placeholder="0.00" disabled={!dbReady || unit === "per_minute"} {...invalid("output")} data-testid={`ai-model-output-price-${m.id}`} />
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

/** Admin > AI settings: one toggle per AI feature. Future features (dictation, voice chat) add a row by adding a feature. */
export function AiFeaturesPanel({ features, dbReady }: { features: AiFeatureView[]; dbReady: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="flex flex-col gap-2" data-testid="ai-features">
      {features.map((f) => {
        const labelId = `ai-feature-${f.feature}-label`;
        const helpId = `ai-feature-${f.feature}-help`;
        return (
          <div key={f.feature} className="flex items-start gap-3 rounded-control border border-line bg-input/60 px-3 py-2.5">
            <AiToggle checked={f.enabled} labelledBy={labelId} describedBy={helpId} disabled={!dbReady || pending} testId={`ai-feature-toggle-${f.feature}`} onChange={(v) => start(async () => {
              const r = await setAiFeatureEnabled(f.feature, v);
              setError(r.ok ? null : r.error);
            })} />
            <div className="min-w-0 flex-1">
              <span id={labelId} className="type-table-strong text-fg">
                {f.label}
              </span>
              <p id={helpId} className="mt-0.5 text-muted type-caption">
                {f.killedByEnv ? C.featureKilled(f.envName) : f.enabled ? C.FEATURE_ON_HELP : C.FEATURE_OFF_HELP}
              </p>
            </div>
          </div>
        );
      })}
      {error && (
        <AiAlert tone="danger" testId="ai-feature-error">
          {error}
        </AiAlert>
      )}
    </div>
  );
}
