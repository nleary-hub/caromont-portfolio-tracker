"use client";

import { useActionState, useState, useTransition } from "react";
import { clearAiKey, saveAiSettings, testAiConnection, type AiSettingsFormState, type AiTestResult } from "@/app/actions/ai";
import { AiCopy as C } from "@/lib/ai/AiCopy";
import { AiProviders, type AiProviderId } from "@/lib/ai/AiProviders";
import type { AiSettingsView } from "@/lib/services/AiSettingsService";

/** 2px focus ring on every control (keyboard focus); the page is wrapped in .pb-page, which rings inputs the same way. */
const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const INPUT = `h-8 w-full min-w-0 rounded-control border border-line bg-input px-2.5 text-fg type-table focus:border-accent disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-danger ${FOCUS}`;
const GHOST = `h-7 rounded-control border border-line px-3 text-fg type-table-strong hover:border-accent disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`;
const PRIMARY = `h-7 rounded-control btn-primary bg-accent-strong px-3.5 text-white type-table-strong disabled:cursor-not-allowed disabled:bg-(--status-not-started-dark-bg) disabled:text-muted ${FOCUS}`;

/**
 * Admin > AI settings form. The key is write-only: the page gets only whether it is set, its last 4 characters and who
 * saved it when. Pasting a key and saving replaces it; Clear key removes it. With no encryption key on the server the
 * key field stays visible but disabled, with the reason; the other settings still save (turning AI off must always
 * work). Test connection is disabled until a provider, model and readable key are saved (it uses the saved settings).
 */
export function AiSettingsForm({ view, keySavedLine, dbReady }: { view: AiSettingsView; keySavedLine: string | null; dbReady: boolean }) {
  const [state, action, pending] = useActionState<AiSettingsFormState, FormData>(saveAiSettings, null);
  const [enabled, setEnabled] = useState(view.enabled);
  const [provider, setProvider] = useState<AiProviderId | "">(view.provider ?? "");
  // The key field shows when no key is saved, or after Replace key. A successful save closes it again.
  const [replacing, setReplacing] = useState(false);
  const [seenState, setSeenState] = useState<AiSettingsFormState>(null);
  if (state !== seenState) {
    setSeenState(state);
    if (state?.ok) setReplacing(false);
  }
  const keyInput = !view.key.set || replacing;
  const [confirmClear, setConfirmClear] = useState(false);
  const [keyMessage, setKeyMessage] = useState<string | null>(null);
  const [test, setTest] = useState<AiTestResult | null>(null);
  const [testing, startTest] = useTransition();
  const [clearing, startClear] = useTransition();
  const err = (f: string) => (state && !state.ok ? state.fieldErrors?.[f] : undefined);
  const keyBlocked = !view.encryption.ready;
  const canTest = dbReady && view.ready;
  const status = !view.enabled ? C.STATUS_OFF : view.ready ? C.STATUS_READY : C.STATUS_NOT_READY;
  const statusClass = !view.enabled ? "bg-(--status-not-started-dark-bg) text-(--status-not-started-dark-fg)" : view.ready ? "bg-(--status-on-track-dark-bg) text-(--status-on-track-dark-fg)" : "bg-(--status-at-risk-dark-bg) text-(--status-at-risk-dark-fg)";
  const switchHelp = !enabled ? C.SWITCH_HELP_OFF : view.enabled && view.ready ? C.SWITCH_HELP_ON : C.SWITCH_ON_NOT_READY;

  return (
    <div className="flex flex-col gap-4">
      <form action={action} className="flex flex-col gap-4" data-testid="ai-settings-form">
        <input type="hidden" name="enabled" value={enabled ? "true" : "false"} />
        {/* On/off */}
        <div className="flex items-start gap-3 rounded-control border border-line bg-input/60 px-3 py-2.5">
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-labelledby="ai-switch-label"
            aria-describedby="ai-switch-help"
            onClick={() => setEnabled((v) => !v)}
            disabled={!dbReady}
            className="acct-switch mt-0.5"
            data-testid="ai-switch"
          >
            <span aria-hidden className="acct-thumb" />
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span id="ai-switch-label" className="type-table-strong text-fg">
                {C.SWITCH_LABEL}
              </span>
              <span className={`rounded-pill px-2 py-px type-label ${statusClass}`} data-testid="ai-status">
                {status}
              </span>
            </div>
            <p id="ai-switch-help" className="mt-0.5 text-muted type-caption">
              {switchHelp}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field id="ai-provider" label={C.PROVIDER_LABEL} error={err("provider")}>
            <select id="ai-provider" name="provider" className={INPUT} value={provider} onChange={(e) => setProvider(e.target.value as AiProviderId | "")} aria-invalid={Boolean(err("provider")) || undefined} disabled={!dbReady}>
              <option value="">{C.PROVIDER_PLACEHOLDER}</option>
              {AiProviders.ALL.map((p) => (
                <option key={p} value={p}>
                  {AiProviders.label(p)}
                </option>
              ))}
            </select>
          </Field>
          <Field id="ai-model" label={C.MODEL_LABEL} error={err("model")} help={C.MODEL_HELP}>
            <input id="ai-model" name="model" className={INPUT} defaultValue={view.model} maxLength={AiProviders.MODEL_MAX} autoComplete="off" spellCheck={false} aria-invalid={Boolean(err("model")) || undefined} disabled={!dbReady} />
          </Field>
          {provider === "openai_compatible" && (
            <div className="col-span-2">
              <Field id="ai-base-url" label={C.BASE_URL_LABEL} error={err("baseUrl")} help={C.BASE_URL_HELP}>
                <input id="ai-base-url" name="baseUrl" className={INPUT} defaultValue={view.baseUrl} maxLength={AiProviders.URL_MAX} autoComplete="off" spellCheck={false} inputMode="url" aria-invalid={Boolean(err("baseUrl")) || undefined} disabled={!dbReady} />
              </Field>
            </div>
          )}
          {provider === "azure_openai" && (
            <>
              <Field id="ai-azure-endpoint" label={C.AZURE_ENDPOINT_LABEL} error={err("azureEndpoint")} help={C.AZURE_ENDPOINT_HELP}>
                <input id="ai-azure-endpoint" name="azureEndpoint" className={INPUT} defaultValue={view.azureEndpoint} maxLength={AiProviders.URL_MAX} autoComplete="off" spellCheck={false} inputMode="url" aria-invalid={Boolean(err("azureEndpoint")) || undefined} disabled={!dbReady} />
              </Field>
              <Field id="ai-azure-deployment" label={C.AZURE_DEPLOYMENT_LABEL} error={err("azureDeployment")}>
                <input id="ai-azure-deployment" name="azureDeployment" className={INPUT} defaultValue={view.azureDeployment} maxLength={AiProviders.MODEL_MAX} autoComplete="off" spellCheck={false} aria-invalid={Boolean(err("azureDeployment")) || undefined} disabled={!dbReady} />
              </Field>
            </>
          )}
        </div>

        {/* API key: write-only. */}
        <div className="flex flex-col gap-1.5" data-testid="ai-key">
          <span className="text-muted type-caption">{C.KEY_LABEL}</span>
          <div className="flex h-8 items-center gap-2">
            <span className={`inline-flex items-center gap-1.5 type-table-strong ${view.key.set ? "text-fg" : "text-muted"}`} data-testid="ai-key-status">
              <span aria-hidden className={`size-2 rounded-full ${view.key.set ? (view.key.readable ? "bg-(--status-on-track-dark-fg)" : "bg-(--status-at-risk-dark-fg)") : "bg-(--status-not-started-dark-fg)"}`} />
              {view.key.set ? C.keySet(view.key.last4) : C.KEY_NOT_SET}
            </span>
            {keySavedLine && <span className="text-muted type-caption" data-testid="ai-key-saved">{keySavedLine}</span>}
            {view.key.set && !confirmClear && (
              <span className="ml-auto flex items-center gap-2">
                <button type="button" className={GHOST} onClick={() => setReplacing((v) => !v)} disabled={keyBlocked || !dbReady} data-testid="ai-key-replace">
                  {replacing ? C.KEY_CANCEL_REPLACE : C.KEY_REPLACE}
                </button>
                <button type="button" className={GHOST} onClick={() => setConfirmClear(true)} disabled={!dbReady} data-testid="ai-key-clear">
                  {C.KEY_CLEAR}
                </button>
              </span>
            )}
          </div>
          {confirmClear && (
            <div className="flex items-center gap-2 rounded-control bg-(--status-off-track-dark-bg) px-3 py-2" role="alert">
              <span className="min-w-0 flex-1 text-fg type-table">{C.KEY_CLEAR_CONFIRM}</span>
              <button type="button" className={`h-7 rounded-control px-2.5 text-muted type-table-strong hover:text-fg ${FOCUS}`} onClick={() => setConfirmClear(false)} data-testid="ai-key-clear-cancel">
                {C.KEY_CLEAR_NO}
              </button>
              <button
                type="button"
                className={`h-7 rounded-control bg-(--status-off-track-dark-bg) px-2.5 text-danger type-table-strong ring-1 ring-danger/40 ${FOCUS}`}
                disabled={clearing}
                onClick={() =>
                  startClear(async () => {
                    const r = await clearAiKey();
                    setKeyMessage(r.message);
                    setConfirmClear(false);
                    setReplacing(false);
                  })
                }
                data-testid="ai-key-clear-confirm"
              >
                {C.KEY_CLEAR_YES}
              </button>
            </div>
          )}
          {view.key.set && !view.key.readable && view.encryption.ready && <p className="text-(--status-at-risk-dark-fg) type-table">{C.KEY_UNREADABLE}</p>}
          {keyBlocked && (
            <p className="rounded-control bg-(--status-at-risk-dark-bg) px-3 py-2 text-(--status-at-risk-dark-fg) type-table" role="status" data-testid="ai-encryption-missing">
              {view.encryption.problem === "invalid" ? C.ENCRYPTION_INVALID : C.ENCRYPTION_MISSING}
            </p>
          )}
          {(keyInput || keyBlocked) && (
            <>
              <input
                id="ai-api-key"
                name="apiKey"
                type="password"
                aria-label={C.KEY_LABEL}
                className={`${INPUT} font-mono`}
                placeholder={view.key.set ? C.KEY_PLACEHOLDER_REPLACE : C.KEY_PLACEHOLDER_NEW}
                autoComplete="new-password"
                spellCheck={false}
                aria-invalid={Boolean(err("apiKey")) || undefined}
                aria-describedby={keyBlocked ? "ai-key-blocked" : undefined}
                disabled={!dbReady || keyBlocked}
                data-testid="ai-key-input"
              />
              {keyBlocked ? null : err("apiKey") ? <p className="text-danger type-table">{err("apiKey")}</p> : <p className="text-muted type-caption">{C.KEY_HELP}</p>}
              {keyBlocked && <span id="ai-key-blocked" className="sr-only">{view.encryption.problem === "invalid" ? C.ENCRYPTION_INVALID : C.ENCRYPTION_MISSING}</span>}
            </>
          )}
          {keyMessage && (
            <p className="text-muted type-table" role="status">
              {keyMessage}
            </p>
          )}
        </div>

        <div className="flex items-center gap-2 border-t border-line pt-3">
          <span className={`min-w-0 flex-1 type-table ${state && !state.ok ? "text-danger" : "text-muted"}`} role={state ? "status" : undefined} data-testid="ai-save-message">
            {state?.message ?? ""}
          </span>
          <button type="submit" className={PRIMARY} disabled={pending || !dbReady} data-testid="ai-save">
            {pending ? C.SAVING : C.SAVE}
          </button>
        </div>
      </form>

      {/* Test connection: the saved settings, a tiny prompt; the result never contains the key. */}
      <div className="flex flex-col gap-2 rounded-control border border-line bg-input/60 px-3 py-2.5" data-testid="ai-test">
        <div className="flex items-center gap-3">
          <button type="button" className={GHOST} disabled={testing || !canTest} onClick={() => startTest(async () => setTest(await testAiConnection()))} data-testid="ai-test-button">
            {testing ? C.TESTING : C.TEST}
          </button>
          <span className="text-muted type-caption" data-testid="ai-test-help">{canTest ? C.TEST_HELP : C.TEST_NEEDS_SETTINGS}</span>
        </div>
        {test && (
          <p role="status" className={`flex items-start gap-2 type-table ${test.ok ? "text-(--status-on-track-dark-fg)" : "text-danger"}`} data-testid={test.ok ? "ai-test-ok" : "ai-test-error"}>
            <span aria-hidden className={`mt-1 size-2 shrink-0 rounded-full ${test.ok ? "bg-(--status-on-track-dark-fg)" : "bg-danger"}`} />
            <span className="min-w-0 break-words">{test.message}</span>
          </p>
        )}
      </div>
    </div>
  );
}

function Field({ id, label, error, help, children }: { id: string; label: string; error?: string; help?: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-muted type-caption">
        {label}
      </label>
      {children}
      {error ? <p className="text-danger type-table">{error}</p> : help ? <p className="text-muted type-caption">{help}</p> : null}
    </div>
  );
}
