import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AdminMenuSlot } from "@/components/AdminMenuSlot";
import { AiFeaturesPanel, AiModelsPanel } from "@/components/AiModelsPanel";
import { AiPriceRefresh } from "@/components/AiPriceRefresh";
import { AiProviderKeysCard } from "@/components/AiProviderKeysCard";
import { AiSettingsForm } from "@/components/AiSettingsForm";
import { OpenAiModelListProvider } from "@/components/useOpenAiModelList";
import { PROVIDER_KEYS_CARD_ID, ProviderModelListsProvider } from "@/components/AiFeatureProviderPicker";
import { AiFeatureProviders, type AiFeatureProvider, type AiProviderKeyStates } from "@/lib/ai/AiFeatureProviders";
import { AiFeatureRuntime, AiProviderKeyAccess } from "@/lib/services/AiFeatureProviderService";
import { AdminMenu } from "@/lib/admin/AdminMenu";
import { AiCopy } from "@/lib/ai/AiCopy";
import { AiFeatureFlags } from "@/lib/ai/AiFeatureFlags";
import { AiKeyCipher } from "@/lib/ai/AiKeyCipher";
import type { AiKeyRowView } from "@/lib/ai/AiKeyProviders";
import { LineAccessService } from "@/lib/services/LineAccessService";
import { AiProviderKeyService, type AiProviderKeyDb, type AiProviderKeyStatus } from "@/lib/services/AiProviderKeyService";
import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import { Db } from "@/lib/db/Db";
import { AiModelService, type AiFeatureChoice, type AiFeatureView, type AiModelDb, type AiModelView } from "@/lib/services/AiModelService";
import { AiSettingsService, type AiSettingsDb, type AiSettingsHistoryRow, type AiSettingsView } from "@/lib/services/AiSettingsService";

/** AI Draft/Fit/Test connection server actions run on this page; the provider call can take up to AiProviderClient.TIMEOUT_MS (60 s). */
export const maxDuration = 90;

export const metadata: Metadata = { title: AdminMenu.AI_SETTINGS };

class AiPageFormat {
  private static readonly WHEN = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/New_York" });

  static when(d: Date | string): string {
    return `${AiPageFormat.WHEN.format(new Date(d))} ET`;
  }
}

/**
 * Admin > AI settings. Admins only: anyone else gets a 404 so the route is not revealed (limited users never see it,
 * and the admin menu lists it only for admins). The page never receives the API key or its ciphertext.
 */
export default async function AiSettingsPage() {
  const viewer = await CurrentViewer.get();
  if (!viewer?.isAdmin) notFound();
  let view: AiSettingsView = AiSettingsService.view(null);
  let history: AiSettingsHistoryRow[] = [];
  let models: AiModelView[] = [];
  let features: AiFeatureView[] = AiModelService.featureViews([]);
  // PR B: each text feature's provider and model, and which providers have a working key (no key, no last 4).
  let choices: Record<string, AiFeatureChoice> = AiModelService.featureChoices([]);
  let keyStates: AiProviderKeyStates = AiFeatureProviders.noKeys();
  let dbReady = Db.isConfigured();
  // Guard (a): on a Vercel preview nothing is decrypted, copied or written; the keys card is read-only.
  const preview = AiKeyCipher.isPreview();
  let keyStatuses: AiProviderKeyStatus[] = [];
  const names = new Map<string, string>();
  if (dbReady) {
    try {
      const db = Db.client as unknown as AiSettingsDb;
      const mdb = Db.client as unknown as AiModelDb;
      // Provider keys first: this copies the legacy OpenAI key into ai_provider_keys once (never on a preview).
      keyStatuses = await AiProviderKeyService.list(Db.client as unknown as AiProviderKeyDb);
      const row = await AiSettingsService.row(db);
      view = AiSettingsService.view(row);
      history = await AiSettingsService.history(db);
      models = AiModelService.views(await AiModelService.list(mdb), row);
      const featureRows = await mdb.aiFeatureSetting.findMany();
      features = AiModelService.featureViews(featureRows);
      choices = AiModelService.featureChoices(featureRows);
      keyStates = AiProviderKeyAccess.statesOf(keyStatuses, preview);
      // The saved model must be one an admin turned on, or the assistant isn't ready (the call would be refused).
      if (view.model && !models.some((m) => m.inUse && m.enabled)) view = { ...view, ready: false, modelOff: true };
      const setters = [...new Set(keyStatuses.map((k) => k.setBy).filter((e): e is string => Boolean(e && e.includes("@"))))];
      if (setters.length) {
        const users = await Db.client.appUser.findMany({ where: { email: { in: setters } } }).catch(() => []);
        for (const u of users) names.set(u.email.toLowerCase(), LineAccessService.displayName(u));
      }
    } catch {
      // Tables not migrated yet (Vercel previews skip migrations): show the defaults, saving is disabled.
      dbReady = false;
    }
  }
  // Chat models that are on under Models, by the provider they were added under (the text feature model pickers).
  const chatModels: Partial<Record<AiFeatureProvider, string[]>> = Object.fromEntries(
    AiFeatureProviders.ALL.map((p) => [p, models.filter((m) => m.enabled && m.kind === "chat" && (m.provider ?? "openai") === p).map((m) => m.id)]),
  );
  // How many features that are on run on each provider's key (the Provider keys card's "Used by" count).
  const featuresUsing = view.enabled ? AiFeatureRuntime.featuresUsing(features, choices, view.provider ?? "") : {};
  const keyRows: AiKeyRowView[] = AiProviderKeyService.rowViews(keyStatuses.length ? keyStatuses : AiProviderKeyService.emptyStatuses(), names, featuresUsing);
  const keySavedLine = view.key.set && view.key.setAt ? AiCopy.keySaved(AiPageFormat.when(view.key.setAt), view.key.setBy ?? "") : null;
  const section = "flex flex-col gap-3 rounded-card border border-line bg-card/80 p-4 backdrop-blur-[20px]";

  return (
    // .pb-page: the standard focus ring on inputs, selects and textareas (polish.css), as in the dashboard and editor.
    <main className="pb-page mx-auto flex max-w-[880px] flex-col gap-6 px-6 py-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="type-title whitespace-nowrap">{AiCopy.PAGE_TITLE}</h1>
        <div className="flex items-center gap-3">
          <AdminMenuSlot viewer={viewer} />
          <Link href="/" className="text-muted type-table-strong hover:text-fg">
            Back to dashboard
          </Link>
        </div>
      </div>
      <p className="text-muted type-caption">{AiCopy.PAGE_INTRO}</p>
      {!dbReady && (
        <p className="rounded-control bg-(--status-at-risk-dark-bg) px-3 py-2 text-(--status-at-risk-dark-fg) type-table" role="status" data-testid="ai-db-missing">
          {Db.isConfigured() ? AiCopy.DB_MISSING : "DATABASE_URL is not configured; showing the defaults."}
        </p>
      )}

      {/* The text feature Provider pickers' "No key" / "Key failing" hints scroll here and focus it. */}
      <section id={PROVIDER_KEYS_CARD_ID} className={`${section} scroll-mt-6 outline-none`} aria-labelledby="provider-keys-heading">
        <AiProviderKeysCard rows={keyRows} preview={preview} dbReady={dbReady} encryptionReady={view.encryption.ready} adminName={viewer.name ?? LineAccessService.displayName({ email: viewer.email })} />
      </section>

      {/* One shared OpenAI model list for the settings card, the Models panel and the feature pickers. */}
      <OpenAiModelListProvider>
      <ProviderModelListsProvider>
      <section className={`${section} relative z-20`} aria-labelledby="ai-settings-heading">
        <h2 id="ai-settings-heading" className="type-heading">
          {AiCopy.SWITCH_LABEL}
        </h2>
        <AiSettingsForm view={view} keySavedLine={keySavedLine} dbReady={dbReady} modelOptions={AiModelService.optionsOf(models, "chat")} />
      </section>

      <section className={section} aria-labelledby="ai-models-heading">
        <h2 id="ai-models-heading" className="type-heading">
          {AiCopy.MODELS_TITLE}
        </h2>
        <p className="text-muted type-caption">{AiCopy.MODELS_INTRO}</p>
        {AiFeatureFlags.isPriceRefreshOn() ? (
          <AiPriceRefresh dbReady={dbReady && models.length > 0}>
            <AiModelsPanel models={models} dbReady={dbReady} keyStates={keyStates} />
          </AiPriceRefresh>
        ) : (
          <AiModelsPanel models={models} dbReady={dbReady} keyStates={keyStates} />
        )}
      </section>

      <section className={section} aria-labelledby="ai-features-heading">
        <h2 id="ai-features-heading" className="type-heading">
          {AiCopy.FEATURES_TITLE}
        </h2>
        <p className="text-muted type-caption">{AiCopy.FEATURES_INTRO}</p>
        <AiFeaturesPanel features={features} dbReady={dbReady} modelOptions={{ transcription: AiModelService.optionsOf(models, "transcription"), realtime: AiModelService.optionsOf(models, "realtime") }} choices={choices} keyStates={keyStates} chatModels={chatModels} mainModel={view.model} />
      </section>
      </ProviderModelListsProvider>
      </OpenAiModelListProvider>

      <section className="flex flex-col gap-2" aria-labelledby="ai-history-heading">
        <h2 id="ai-history-heading" className="type-heading">
          {AiCopy.HISTORY_TITLE}
        </h2>
        <div className="overflow-x-auto rounded-card border border-line">
          <table className="w-full type-table" data-testid="ai-history">
            <thead className="bg-card text-left text-muted type-label">
              <tr>
                {AiCopy.HISTORY_HEADERS.map((h) => (
                  <th key={h} className="px-3 py-2 font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {history.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-3 py-4 text-center text-muted">
                    {AiCopy.HISTORY_EMPTY}
                  </td>
                </tr>
              )}
              {history.map((h) => (
                <tr key={h.id} className="border-t border-line">
                  <td className="px-3 py-2 whitespace-nowrap">{AiPageFormat.when(h.changedAt)}</td>
                  <td className="px-3 py-2">{h.changedBy}</td>
                  <td className="px-3 py-2">{AiCopy.fieldLabel(h.field)}</td>
                  <td className="px-3 py-2">{AiCopy.historyChange(h.field, h.action, h.oldValue, h.newValue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
