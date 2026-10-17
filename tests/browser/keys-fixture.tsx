import { AiProviderKeysCard, type AiKeyActions } from "../../src/components/AiProviderKeysCard";
import { AiKeyCopy, type AiKeyActionResult, type AiKeyProvider, type AiKeyRowView, type AiKeyState } from "../../src/lib/ai/AiKeyProviders";

// Fictional admins and FAKE keys, in-memory actions only (?keys=admin|empty|preview). No auth, database or network.
// &test=fail|down: every key test fails (401 or unreachable). &rotate=fail: the rotate's test fails.
// &hold=1: tests and rotates wait for window.__release() (screenshots of the Testing and Rotating states).
const q = new URLSearchParams(window.location.search);
const mode = q.get("keys") ?? "admin";
const SET_AT = "2026-10-17T13:41:00.000Z";
const TESTED_AT = "2026-10-17T13:41:30.000Z";

type Stored = { last4: string; setAt: string; state: AiKeyState; testedAt: string | null };
const store = new Map<AiKeyProvider, Stored>();
if (mode !== "empty") store.set("openai", { last4: "a1B2", setAt: SET_AT, state: "ok", testedAt: TESTED_AT });
if (mode === "preview") store.set("anthropic", { last4: "Q7rT", setAt: "2026-10-16T19:05:00.000Z", state: "untested", testedAt: null });

const row = (provider: AiKeyProvider): AiKeyRowView => {
  const s = store.get(provider);
  return {
    provider, set: Boolean(s), last4: s?.last4 ?? "", setAt: s?.setAt ?? null, setBy: s ? (provider === "anthropic" ? "Casey Lund" : "Jordan Pike") : null,
    label: null, baseUrl: null, readable: mode !== "preview", featuresUsing: provider === "openai" ? 4 : 0,
    status: { state: s?.state ?? "none", testedAt: s?.testedAt ?? null, message: null },
  };
};

type W = { __keyCalls?: { action: string; provider: string; keyLength?: number; baseUrl?: string; label?: string }[]; __release?: () => void };
const w = window as unknown as W;
const record = (c: NonNullable<W["__keyCalls"]>[number]) => (w.__keyCalls ??= []).push(c);
const hold = () => (q.has("hold") ? new Promise<void>((r) => (w.__release = () => r())) : new Promise<void>((r) => setTimeout(r, 150)));
const view = (provider: AiKeyProvider, message: string | null = null) => {
  const s = store.get(provider);
  return { provider, last4: s?.last4 ?? "", setAt: s?.setAt ?? null, status: { state: s?.state ?? ("none" as const), testedAt: s?.testedAt ?? null, message } };
};
const outcome = (): { state: AiKeyState; message: string | null } =>
  q.get("test") === "fail" ? { state: "rejected", message: AiKeyCopy.rejected(401) } : q.get("test") === "down" ? { state: "unreachable", message: null } : { state: "ok", message: null };

const actions: AiKeyActions = {
  save: async (provider, apiKey, baseUrl, label) => {
    record({ action: "save", provider, keyLength: apiKey.length, baseUrl, label });
    await new Promise((r) => setTimeout(r, 100));
    store.set(provider, { last4: apiKey.trim().slice(-4), setAt: "2026-10-17T13:52:00.000Z", state: "untested", testedAt: null });
    return { ok: true, ...view(provider) } as AiKeyActionResult;
  },
  test: async (provider) => {
    record({ action: "test", provider });
    await hold();
    const o = outcome();
    const s = store.get(provider)!;
    store.set(provider, { ...s, state: o.state, testedAt: "2026-10-17T13:53:00.000Z" });
    const message = o.state === "unreachable" ? AiKeyCopy.unreachable(provider) : o.message;
    return (o.state === "ok" ? { ok: true, ...view(provider) } : { ok: false, error: message!, ...view(provider, message) }) as AiKeyActionResult;
  },
  rotate: async (provider, apiKey) => {
    record({ action: "rotate", provider, keyLength: apiKey.length });
    await hold();
    if (q.get("rotate") === "fail") return { ok: false, error: AiKeyCopy.rejected(401), ...view(provider, AiKeyCopy.rejected(401)) } as AiKeyActionResult;
    store.set(provider, { last4: apiKey.trim().slice(-4), setAt: "2026-10-17T13:55:00.000Z", state: "ok", testedAt: "2026-10-17T13:55:00.000Z" });
    return { ok: true, ...view(provider) } as AiKeyActionResult;
  },
  remove: async (provider, confirmed) => {
    record({ action: "delete", provider });
    if (confirmed) store.delete(provider);
    return { ok: true, ...view(provider) } as AiKeyActionResult;
  },
};

export function KeysFixture() {
  return (
    <main className="pb-page mx-auto flex max-w-[880px] flex-col gap-6 px-6 py-6">
      <section className="flex flex-col gap-3 rounded-card border border-line bg-card/80 p-4 backdrop-blur-[20px]" aria-labelledby="provider-keys-heading" data-testid="keys-section">
        <AiProviderKeysCard rows={(["openai", "anthropic", "xai", "other"] as const).map(row)} preview={mode === "preview"} dbReady encryptionReady={mode !== "preview"} adminName="Jordan Pike" actions={actions} />
      </section>
    </main>
  );
}
