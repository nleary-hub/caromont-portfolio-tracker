import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { PgProviderKeyDb } from "./helpers/PgProviderKeyDb";

// The real Server Functions with the session and database swapped for fictional ones. FAKE keys only.
const h = vi.hoisted(() => ({ viewer: null as (Viewer & { name?: string | null }) | null, db: null as unknown }));
vi.mock("@/lib/auth/CurrentViewer", () => ({ CurrentViewer: { get: async () => h.viewer } }));
vi.mock("@/lib/db/Db", () => ({ Db: { get client() { return h.db; }, isConfigured: () => true } }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));

const { saveProviderKey, rotateProviderKey, testProviderKey, deleteProviderKey } = await import("@/app/actions/aiKeys");

const KEY = "sk-ant-test-FictionalActionKey00k1L2";
const NEXT = "sk-ant-test-FictionalActionKey00m3N4";

describe("Provider keys Server Functions", () => {
  beforeEach(async () => {
    vi.stubEnv("AI_SETTINGS_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
    vi.stubEnv("VERCEL_ENV", "production");
    h.db = (await PgProviderKeyDb.create()).db;
    h.viewer = { email: "jordan.pike@example.org", isAdmin: true, name: "Jordan Pike" };
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("responses carry only provider, last 4, set date and status", async () => {
    const responses = [await saveProviderKey("anthropic", KEY), await testProviderKey("anthropic"), await rotateProviderKey("anthropic", NEXT), await deleteProviderKey("anthropic", true)];
    for (const r of responses) {
      expect(r.ok).toBe(true);
      expect(Object.keys(r).sort()).toEqual(["last4", "ok", "provider", "setAt", "status"]);
      expect(JSON.stringify(r)).not.toMatch(/sk-ant|v1:|ciphertext/);
    }
    expect(responses[1]).toMatchObject({ last4: "k1L2", status: { state: "ok" } });
    expect(responses[2]).toMatchObject({ last4: "m3N4" });
    expect(responses[3]).toMatchObject({ last4: "", setAt: null, status: { state: "none" } });
  });

  it("delete needs the confirm flag; non-admins and signed-out callers are refused", async () => {
    await saveProviderKey("xai", "xai-test-FictionalActionKey000p5Q6");
    expect(await deleteProviderKey("xai", false)).toEqual({ ok: false, error: "Couldn't save the key. Try again." });
    h.viewer = { email: "riley.moss@example.org", isAdmin: false, name: "Riley Moss" };
    for (const r of [await saveProviderKey("xai", KEY), await testProviderKey("xai"), await rotateProviderKey("xai", NEXT), await deleteProviderKey("xai", true)]) expect(r).toEqual({ ok: false, error: "Not authorized." });
    h.viewer = null;
    expect(await testProviderKey("xai")).toEqual({ ok: false, error: "Not authorized." });
  });

  it("on a preview every action refuses before decrypting", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    expect(await saveProviderKey("openai", KEY)).toEqual({ ok: false, error: "AI is off on preview deployments." });
    expect(await testProviderKey("openai")).toEqual({ ok: false, error: "AI is off on preview deployments." });
  });
});
