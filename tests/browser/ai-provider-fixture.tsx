import { AiFeaturesPanel } from "../../src/components/AiModelsPanel";
import { PROVIDER_KEYS_CARD_ID, ProviderModelListsProvider } from "../../src/components/AiFeatureProviderPicker";
import { OpenAiModelListProvider } from "../../src/components/useOpenAiModelList";
import type { AiProviderKeyStates } from "../../src/lib/ai/AiFeatureProviders";

// ?aip=1: Admin > AI settings > Features with per-feature provider pickers. Fictional models, no real keys, and a MOCKED
// provider: listAiProviderModels and setAiFeatureProvider are in-memory fakes (no network, no database).
// &lost=1: Anthropic's key was removed after Bulk edit was moved to it (the amber Provider key missing tag).
const q = new URLSearchParams(window.location.search);
const keyStates: AiProviderKeyStates = { openai: "ok", anthropic: q.has("lost") ? "missing" : "ok", xai: "missing", other: "failing" };
const LISTS: Record<string, { id: string; kind: "chat" }[]> = {
  anthropic: [{ id: "claude-example-sonnet", kind: "chat" }, { id: "claude-example-haiku", kind: "chat" }],
  xai: [{ id: "grok-example-4", kind: "chat" }],
  other: [],
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Only in this mode, so the other fixtures keep their own fakes.
if (q.has("aip")) (globalThis as unknown as { __fixtureActions: Record<string, (...a: never[]) => unknown> }).__fixtureActions = {
  listAiProviderModels: (async (provider: string) => {
    const w = window as unknown as { __listCalls?: string[] };
    (w.__listCalls ??= []).push(provider);
    await wait(120);
    return { ok: true, models: LISTS[provider] ?? [] };
  }) as never,
  // Every save is recorded on window.__providerSaves so tests can read the exact payload.
  setAiFeatureProvider: (async (feature: string, provider: string, model: string) => {
    const w = window as unknown as { __providerSaves?: unknown[] };
    (w.__providerSaves ??= []).push({ feature, provider, model });
    await wait(80);
    return { ok: true };
  }) as never,
  setAiFeatureEnabled: (async () => ({ ok: true })) as never,
  setAiFeatureModel: (async () => ({ ok: true })) as never,
};

const openAiList = { ok: true as const, models: [
  { id: "gpt-example-mini", kind: "chat" as const }, { id: "gpt-example-pro", kind: "chat" as const },
  { id: "gpt-live-example", kind: "realtime" as const }, { id: "gpt-example-transcribe", kind: "transcription" as const }] };
const feature = (id: string, label: string, extra: Record<string, unknown> = {}) =>
  ({ feature: id, label, enabled: true, killedByEnv: false, envName: `AI_${id.toUpperCase()}`, ownModel: false, model: null, ...extra }) as never;

export function AiProviderFixture() {
  return (
    <OpenAiModelListProvider initial={openAiList}>
      <ProviderModelListsProvider>
        <main className="pb-page mx-auto flex max-w-[880px] flex-col gap-6 px-6 py-6">
          <section className="flex flex-col gap-3 rounded-card border border-line bg-card/80 p-4" data-testid="ai-provider-fixture">
            <h2 className="type-title">Features</h2>
            <AiFeaturesPanel
              dbReady
              keyStates={keyStates}
              mainModel="gpt-example-mini"
              chatModels={{ openai: ["gpt-example-mini", "gpt-example-pro"], anthropic: ["claude-example-sonnet"], xai: [], other: [] }}
              choices={{ bulk_edit: { provider: "anthropic", model: "claude-example-sonnet" } }}
              modelOptions={{ realtime: ["gpt-live-example"], transcription: ["gpt-example-transcribe"] }}
              features={[
                feature("meeting_notes", "Meeting notes"),
                feature("bulk_edit", "Bulk edit"),
                feature("next_step", "Next step"),
                feature("voice_chat", "Voice chat", { ownModel: true, model: "gpt-live-example", instructions: "" }),
                feature("dictation", "Dictation", { ownModel: true, model: "gpt-example-transcribe" }),
              ]}
            />
          </section>
          <section id={PROVIDER_KEYS_CARD_ID} className="mt-[900px] flex flex-col gap-3 rounded-card border border-line bg-card/80 p-4" data-testid="ai-provider-keys-card">
            <h2 className="type-title">Provider keys</h2>
            <p className="type-caption text-muted">Fictional placeholder for the Provider keys card (PR A).</p>
          </section>
        </main>
      </ProviderModelListsProvider>
    </OpenAiModelListProvider>
  );
}
