import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it, vi } from "vitest";
import { AiCopy } from "@/lib/ai/AiCopy";
import { AiKeyCipher } from "@/lib/ai/AiKeyCipher";
import { AiPrompts } from "@/lib/ai/AiPrompts";
import { AiProviderClient, type AiRuntimeConfig, type FetchLike } from "@/lib/ai/AiProviderClient";
import { AiProviders } from "@/lib/ai/AiProviders";
import { ServiceLine } from "@/lib/domain/ServiceLine";
import { AiRetentionService, type AiRetentionDb } from "@/lib/services/AiRetentionService";
import { AiSettingsService } from "@/lib/services/AiSettingsService";
import { AI_TEST_FEATURE, AiWritingService } from "@/lib/services/AiWritingService";
import { FakeAiDb } from "./helpers/FakeAiDb";

// Example data only: a random throwaway encryption key and an obviously fake API key.
const ENV = { AI_SETTINGS_ENCRYPTION_KEY: randomBytes(32).toString("base64") };
const API_KEY = "sk-example-not-a-real-key-0000000000";
const ADMIN = { email: "admin@example.com", isAdmin: true };
const SCOPE = ServiceLine.defaultScope();
const FIELDS = { enabled: true, provider: "openai" as const, model: "gpt-6-luna", baseUrl: "", azureEndpoint: "", azureDeployment: "" };

class SpyFetch {
  calls = 0;
  constructor(private status = 200, private reply = "OK") {}
  fetch: FetchLike = async () => {
    this.calls++;
    const payload = this.status === 200 ? { choices: [{ message: { content: this.reply } }] } : { error: { message: `bad key ${API_KEY}` } };
    return { ok: this.status === 200, status: this.status, text: async () => JSON.stringify(payload) };
  };
}

const config = (model: string): AiRuntimeConfig => ({ provider: "openai", model, baseUrl: null, azureEndpoint: null, azureDeployment: null, apiKey: API_KEY });

describe("model allowlist (fallback seed gpt-6-luna; admins choose the rest in step 3b)", () => {
  it("the fallback allows exactly gpt-6-luna", () => {
    expect(AiProviders.ALLOWED_MODELS).toEqual(["gpt-6-luna"]);
    expect(AiProviders.modelAllowed("gpt-6-luna")).toBe(true);
    for (const m of ["gpt-4o-mini", "GPT-6-LUNA", "gpt-6-luna-preview", "claude-3-5-haiku-latest", "", null]) expect(AiProviders.modelAllowed(m)).toBe(false);
  });

  it("copy is plain English without em dashes", () => {
    expect(AiCopy.MODEL_NOT_ALLOWED).not.toContain("gpt-6-luna");
    expect(AiCopy.MODEL_NOT_ALLOWED + AiCopy.MODEL_HELP).not.toMatch(/\u2014/);
  });

  it("save rejects any other model (switch on or off) and stores nothing", async () => {
    for (const enabled of [true, false]) {
      const db = new FakeAiDb();
      const r = await AiSettingsService.save(db, ADMIN, { fields: { ...FIELDS, enabled, model: "gpt-4o-mini" }, newKey: API_KEY }, ENV);
      expect(r).toEqual({ ok: false, error: AiCopy.FIX_FIELDS, fieldErrors: { model: AiCopy.MODEL_NOT_ALLOWED } });
      expect(db.settings).toBeNull();
      expect(db.writes).toEqual([]);
    }
  });

  it("save rejects the model from a form post (the server action path)", async () => {
    const form = new FormData();
    form.set("enabled", "on");
    form.set("provider", "openai");
    form.set("model", "some-other-model");
    form.set("apiKey", API_KEY);
    const r = await AiSettingsService.save(new FakeAiDb(), ADMIN, AiSettingsService.parseForm(form), ENV);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.fieldErrors?.model).toBe(AiCopy.MODEL_NOT_ALLOWED);
  });

  it("save accepts gpt-6-luna", async () => {
    expect(await AiSettingsService.save(new FakeAiDb(), ADMIN, { fields: FIELDS, newKey: API_KEY }, ENV)).toEqual({ ok: true });
  });

  it("AiProviderClient refuses another model without calling the provider", async () => {
    const spy = new SpyFetch();
    const r = await AiProviderClient.complete(config("gpt-4o-mini"), { system: "s", user: "u", maxTokens: 10 }, spy.fetch);
    expect(r).toMatchObject({ ok: false, kind: "model_not_allowed", message: AiCopy.MODEL_NOT_ALLOWED });
    expect(spy.calls).toBe(0);
    expect((await AiProviderClient.complete(config("gpt-6-luna"), { system: "s", user: "u", maxTokens: 10 }, spy.fetch)).ok).toBe(true);
    expect(spy.calls).toBe(1);
  });

  it("AiWritingService.suggest refuses a saved model outside the list (row from before the allowlist)", async () => {
    const db = new FakeAiDb();
    const key = AiKeyCipher.fromEnv(ENV);
    if (!key.ok) throw new Error("test key");
    const now = new Date("2026-10-14T12:00:00Z");
    db.settings = {
      id: "ai", enabled: true, provider: "openai", model: "gpt-4o-mini", baseUrl: null, azureEndpoint: null, azureDeployment: null,
      apiKeyCiphertext: AiKeyCipher.encrypt(API_KEY, key.key), apiKeyLast4: AiKeyCipher.last4(API_KEY), apiKeySetAt: now, apiKeySetBy: ADMIN.email, updatedAt: now, updatedBy: ADMIN.email,
    };
    const spy = new SpyFetch();
    const r = await AiWritingService.suggest({ db, viewer: ADMIN, scope: SCOPE, projectId: null, feature: "draft_from_bullets", text: "example notes", env: ENV, fetchImpl: spy.fetch });
    expect(r).toEqual({ ok: false, kind: "provider", message: AiCopy.MODEL_NOT_ALLOWED });
    expect(spy.calls).toBe(0);
  });

  it("Test connection refuses another model without calling the provider", async () => {
    const spy = new SpyFetch();
    expect(await AiWritingService.testConnection(config("gpt-4o-mini"), spy.fetch)).toEqual({ ok: false, message: AiCopy.MODEL_NOT_ALLOWED });
    expect(spy.calls).toBe(0);
  });
});

describe("Test connection usage log (metadata only)", () => {
  const NOW = new Date("2026-10-14T12:00:00Z");
  for (const [label, status] of [["success", 200], ["failure", 401]] as const) {
    it(`logs a ${label} with no key, prompt or reply`, async () => {
      const db = new FakeAiDb();
      const spy = new SpyFetch(status, "OK from the example provider");
      await AiWritingService.testConnection(config("gpt-6-luna"), spy.fetch, { db, viewer: ADMIN, now: () => NOW });
      expect(db.usage).toHaveLength(1);
      const row = db.usage[0];
      expect(row).toMatchObject({
        userEmail: ADMIN.email, projectId: null, feature: AI_TEST_FEATURE, event: status === 200 ? "test_succeeded" : "test_failed",
        provider: "openai", model: "gpt-6-luna", inputLength: "Connection test.".length, suggestedText: null, numberCheckPassed: null, createdAt: NOW,
      });
      expect(row.outputLength).toBe(status === 200 ? "OK from the example provider".length : null);
      const dump = JSON.stringify(row);
      for (const secret of [API_KEY, "Connection test.", "Reply with the single word OK.", "OK from the example provider", "bad key"]) expect(dump).not.toContain(secret);
    });
  }

  it("test rows don't count toward the writing rate limit", () => {
    expect(["test_succeeded", "test_failed"]).not.toContain("suggested");
    expect(AiPrompts.parseFeature(AI_TEST_FEATURE)).toBeNull();
  });
});

// ---- Retention, against the real migrations in PGlite --------------------------------------------------------------
const DIR = path.resolve(__dirname, "../prisma/migrations");
const FIXTURE = readFileSync(path.resolve(__dirname, "fixtures/prod-shape-0015.sql"), "utf8");
const folders = () => readdirSync(DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
const sql = (f: string) => readFileSync(path.join(DIR, f, "migration.sql"), "utf8");

async function migrated(): Promise<PGlite> {
  const db = await PGlite.create();
  for (const f of folders()) {
    if (f === "0016_service_lines") break;
    await db.exec(sql(f));
  }
  await db.exec(FIXTURE);
  for (const f of folders().filter((x) => x >= "0016")) await db.exec(sql(f));
  return db;
}

/** Translates the one updateMany the service makes into SQL, so the 0035 trigger judges it. */
const pgRetention = (db: PGlite): AiRetentionDb => ({
  aiUsageLog: {
    updateMany: async (args) => {
      const removed = args.data.userEmail;
      const r = await db.query(
        `UPDATE "ai_usage_log" SET "suggestedText" = NULL, "userEmail" = $2 WHERE "createdAt" < $1 AND ("suggestedText" IS NOT NULL OR "userEmail" <> $2)`,
        [args.where.createdAt.lt.toISOString(), removed],
      );
      return { count: r.affectedRows ?? 0 };
    },
  },
});

async function insert(db: PGlite, daysAgo: number, event = "suggested", feature = "draft_from_bullets") {
  const id = randomUUID();
  await db.query(
    `INSERT INTO "ai_usage_log" ("id","suggestionId","userEmail","feature","event","provider","model","inputLength","outputLength","suggestedText","createdAt")
     VALUES ($1,$2,'editor@example.com',$3,$4,'openai','gpt-6-luna',12,20,$5,(now() AT TIME ZONE 'UTC') - make_interval(days => $6))`,
    [id, randomUUID(), feature, event, event === "suggested" ? "Example suggestion text." : null, daysAgo],
  );
  return id;
}

describe("ai_usage_log retention (0035 + AiRetentionService)", () => {
  it("scrubs suggestedText and userEmail only on rows older than 30 days, keeps metadata, deletes nothing", async () => {
    const db = await migrated();
    const old1 = await insert(db, 45);
    const old2 = await insert(db, 31, "accepted");
    const recent = await insert(db, 29);
    const today = await insert(db, 0);
    const r = await AiRetentionService.run(pgRetention(db), new Date());
    expect(r.scrubbed).toBe(2);
    const rows = (await db.query<{ id: string; userEmail: string; suggestedText: string | null; model: string; inputLength: number }>(`SELECT * FROM "ai_usage_log"`)).rows;
    expect(rows).toHaveLength(4);
    const by = (id: string) => rows.find((x) => x.id === id)!;
    for (const id of [old1, old2]) expect(by(id)).toMatchObject({ userEmail: AiRetentionService.REMOVED_EMAIL, suggestedText: null, model: "gpt-6-luna", inputLength: 12 });
    for (const id of [recent, today]) expect(by(id)).toMatchObject({ userEmail: "editor@example.com" });
    expect(by(recent).suggestedText).toBe("Example suggestion text.");
    // A second run finds nothing left to do.
    expect((await AiRetentionService.run(pgRetention(db), new Date())).scrubbed).toBe(0);
  });

  it("the trigger still refuses deletes, updates of recent rows and any other column change", async () => {
    const db = await migrated();
    const old = await insert(db, 40);
    const recent = await insert(db, 5);
    await expect(db.query(`DELETE FROM "ai_usage_log" WHERE "id" = $1`, [old])).rejects.toThrow(/not allowed/);
    await expect(db.query(`UPDATE "ai_usage_log" SET "suggestedText" = NULL WHERE "id" = $1`, [recent])).rejects.toThrow(/not allowed/);
    await expect(db.query(`UPDATE "ai_usage_log" SET "suggestedText" = NULL, "model" = 'x' WHERE "id" = $1`, [old])).rejects.toThrow(/not allowed/);
    await expect(db.query(`UPDATE "ai_usage_log" SET "suggestedText" = 'changed' WHERE "id" = $1`, [old])).rejects.toThrow(/not allowed/);
    await expect(db.query(`UPDATE "ai_usage_log" SET "suggestedText" = NULL, "userEmail" = 'someone@example.com' WHERE "id" = $1`, [old])).rejects.toThrow(/not allowed/);
  });

  it("0035 accepts test_connection rows and still refuses unknown values", async () => {
    const db = await migrated();
    await insert(db, 0, "test_succeeded", "test_connection");
    await insert(db, 0, "test_failed", "test_connection");
    await expect(insert(db, 0, "made_up")).rejects.toThrow();
    await expect(insert(db, 0, "suggested", "made_up")).rejects.toThrow();
  });

  it("the service only targets rows before the 30-day cutoff", async () => {
    const seen: unknown[] = [];
    const now = new Date("2026-10-14T12:00:00Z");
    await AiRetentionService.run({ aiUsageLog: { updateMany: async (a) => (seen.push(a), { count: 0 }) } }, now);
    expect(seen[0]).toMatchObject({ where: { createdAt: { lt: new Date("2026-09-14T12:00:00Z") } }, data: { suggestedText: null, userEmail: "[removed]" } });
  });
});

describe("cron wiring", () => {
  it("vercel.json adds the daily ai-retention cron and keeps both freeze crons", () => {
    const v = JSON.parse(readFileSync(path.resolve(__dirname, "../vercel.json"), "utf8")) as { crons: { path: string; schedule: string }[] };
    expect(v.crons).toContainEqual({ path: "/api/cron/ai-retention", schedule: "0 9 * * *" });
    expect(v.crons.filter((c) => c.path === "/api/cron/freeze")).toEqual([
      { path: "/api/cron/freeze", schedule: "0 21 * * *" },
      { path: "/api/cron/freeze", schedule: "0 22 * * *" },
    ]);
  });

  it("the retention route checks CRON_SECRET and is separate from the freeze route", () => {
    const route = readFileSync(path.resolve(__dirname, "../src/app/api/cron/ai-retention/route.ts"), "utf8");
    const freeze = readFileSync(path.resolve(__dirname, "../src/app/api/cron/freeze/route.ts"), "utf8");
    expect(route).toContain("ReportHttp.cronAuthorized");
    expect(route).not.toMatch(/FreezeService|cron\/freeze"/);
    expect(freeze).not.toMatch(/AiRetention|ai-retention/);
  });
});

// The form imports its Server Functions (session, DB); the field render needs none of them.
vi.mock("@/app/actions/ai", () => ({ saveAiSettings: vi.fn(), clearAiKey: vi.fn(), testAiConnection: vi.fn() }));

describe("model field styles (Figma review)", () => {
  it("help: grey hint under the field, named by aria-describedby", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { ModelField } = await import("@/components/AiSettingsForm");
    const html = renderToStaticMarkup(createElement(ModelField, { value: "gpt-6-luna" }));
    expect(html).toContain('aria-describedby="ai-model-help"');
    expect(html).toMatch(/<p id="ai-model-help" class="text-muted type-caption">/);
    expect(html).not.toContain("aria-invalid=");
  });

  it("error: red alert box (role=alert), red border, 2px focus outline, announced via aria-describedby (picker button, step 3b)", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { ModelField } = await import("@/components/AiSettingsForm");
    const html = renderToStaticMarkup(createElement(ModelField, { value: "some-other-model", error: AiCopy.MODEL_NOT_ALLOWED }));
    expect(html).toContain('aria-describedby="ai-model-error"');
    expect(html).toContain("border-danger");
    expect(html).toContain('id="ai-model-error"');
    expect(html).toMatch(/role="alert" class="[^"]*bg-\(--status-off-track-dark-bg\) text-danger/);
    expect(html).toContain("focus-visible:outline-2");
    expect(html).toContain("That model isn&#x27;t turned on. Choose a model that is on under Models.");
    expect(html).not.toContain("ai-model-help");
  });
});
