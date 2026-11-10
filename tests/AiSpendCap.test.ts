import { randomBytes, randomUUID } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@/generated/prisma/client";
import { AiKeyCipher } from "@/lib/ai/AiKeyCipher";
import type { FetchLike } from "@/lib/ai/AiProviderClient";
import { AiSpendCap, AiSpendCopy } from "@/lib/ai/AiSpendCap";
import { ServiceLine } from "@/lib/domain/ServiceLine";
import { AiSpendCapService, type AiSpendCapReadDb, type AiSpendCapWriteDb } from "@/lib/services/AiSpendCapService";
import { AiWritingService } from "@/lib/services/AiWritingService";
import { FakeAiDb } from "./helpers/FakeAiDb";
import { migratedPglite, refusal, registryHarness, type RegistryHarness } from "./helpers/PgRegistryDb";

// Monthly AI spend caps (0074). Fictional people and amounts only.
const ADMIN = { email: "admin@example.test", isAdmin: true };
const ANA = "ana@example.test";
const NOW = new Date("2026-11-10T15:00:00Z");
const now = () => NOW;

describe("AiSpendCap rules", () => {
  it("parses amounts: blank removes, money text is accepted, anything else is refused", () => {
    expect(AiSpendCap.parseAmount("")).toBeNull();
    expect(AiSpendCap.parseAmount("  ")).toBeNull();
    expect(AiSpendCap.parseAmount(null)).toBeNull();
    expect(AiSpendCap.parseAmount("10")).toBe(10);
    expect(AiSpendCap.parseAmount("$1,000.50")).toBe(1000.5);
    expect(AiSpendCap.parseAmount("0")).toBe(0);
    for (const bad of ["-1", "abc", "10.001", "10001", "1e3", {}]) expect(AiSpendCap.parseAmount(bad)).toBeUndefined();
  });

  it("own cap beats the default; no rows means no cap", () => {
    expect(AiSpendCap.effective({ own: 5, fallback: 10 })).toEqual({ capUsd: 5, source: "own" });
    expect(AiSpendCap.effective({ own: null, fallback: 10 })).toEqual({ capUsd: 10, source: "default" });
    expect(AiSpendCap.effective({ own: null, fallback: null })).toEqual({ capUsd: null, source: "none" });
  });

  it("allows spend under the cap only; a cap of 0 allows nothing", () => {
    expect(AiSpendCap.allows(null, 1e9)).toBe(true);
    expect(AiSpendCap.allows(10, 9.99)).toBe(true);
    expect(AiSpendCap.allows(10, 10)).toBe(false);
    expect(AiSpendCap.allows(0, 0)).toBe(false);
  });

  it("counts the calendar month in Eastern time, across the daylight-saving change", () => {
    expect(AiSpendCap.monthStart(new Date("2026-11-10T15:00:00Z")).toISOString()).toBe("2026-11-01T04:00:00.000Z");
    expect(AiSpendCap.monthStart(new Date("2026-12-15T15:00:00Z")).toISOString()).toBe("2026-12-01T05:00:00.000Z");
    // 11:30 PM on Oct 31 in New York is still October.
    expect(AiSpendCap.monthStart(new Date("2026-11-01T03:30:00Z")).toISOString()).toBe("2026-10-01T04:00:00.000Z");
    expect(AiSpendCap.nextMonthStart(new Date("2026-12-15T15:00:00Z")).toISOString()).toBe("2027-01-01T05:00:00.000Z");
    expect(AiSpendCap.resetLabel(NOW)).toBe("December 1");
  });

  it("the cap message is plain and names where to change it", () => {
    expect(AiSpendCopy.reached(10, "December 1")).toContain("$10.00");
    expect(AiSpendCopy.reached(10, "December 1")).toContain("December 1");
    expect(AiSpendCopy.reached(0, "December 1")).toContain("$0");
    expect(AiSpendCopy.reached(10, "December 1") + AiSpendCopy.INTRO).not.toMatch(/—/);
  });
});

describe("0074 on a real Postgres through Prisma", () => {
  let h: RegistryHarness;
  let db: AiSpendCapWriteDb & AiSpendCapReadDb;
  beforeAll(async () => {
    h = await registryHarness();
    db = h.prisma as unknown as AiSpendCapWriteDb & AiSpendCapReadDb;
  });
  afterAll(async () => {
    await h?.stop();
  });
  // ai_usage_log is append-only (a DB trigger), so each test gets its own fictional people instead of a cleanup.
  let ANA = "";
  let BEN = "";
  let n = 0;
  beforeEach(async () => {
    n++;
    ANA = `ana${n}@example.test`;
    BEN = `ben${n}@example.test`;
    await h.pg.exec(`DELETE FROM ai_spend_caps`);
  });

  const spend = async (email: string, costUsd: number, createdAt = NOW) =>
    h.prisma.aiUsageLog.create({ data: { suggestionId: randomUUID(), userEmail: email, feature: "draft_from_bullets", event: "suggested", inputLength: 10, costUsd, createdAt } });
  const set = (target: string, amount: string, viewer: { email: string; isAdmin: boolean } | null = ADMIN, env: Record<string, string | undefined> = {}) =>
    AiSpendCapService.setCap({ db, viewer, target, amount, env, now });

  it("no cap rows: everyone may call AI, however much they spent", async () => {
    await spend(ANA, 500);
    expect(await AiSpendCapService.check({ db, email: ANA, now })).toEqual({ ok: true });
  });

  it("the default cap blocks once this month's spend reaches it; last month does not count", async () => {
    expect(await set("default", "10")).toEqual({ ok: true });
    await spend(ANA, 6);
    await spend(ANA, 50, new Date("2026-10-20T12:00:00Z"));
    expect(await AiSpendCapService.check({ db, email: ANA, now })).toEqual({ ok: true });
    await spend(ANA, 4);
    expect(await AiSpendCapService.check({ db, email: ANA.replace("ana", "Ana"), now })).toEqual({ ok: false, reason: "cap", message: AiSpendCopy.reached(10, "December 1") });
  });

  it("a person's own cap overrides the default, and removing it falls back to the default", async () => {
    await set("default", "10");
    await set(BEN, "25");
    await spend(BEN, 12);
    expect((await AiSpendCapService.check({ db, email: BEN, now })).ok).toBe(true);
    await set(BEN, "");
    expect((await AiSpendCapService.check({ db, email: BEN, now })).ok).toBe(false);
  });

  it("a cap of 0 turns AI off for that person only", async () => {
    await set(ANA, "0");
    expect(await AiSpendCapService.check({ db, email: ANA, now })).toMatchObject({ ok: false, reason: "cap" });
    expect((await AiSpendCapService.check({ db, email: BEN, now })).ok).toBe(true);
  });

  it("writes one history row per change, none for a repeat save, and history cannot be edited", async () => {
    await set(ANA, "15");
    await set(ANA, "15.00");
    await set(ANA, "20");
    await set(ANA, "");
    const rows = (await h.pg.query<{ old: string | null; new: string | null; by: string }>(`SELECT "oldCapUsd" AS old, "newCapUsd" AS new, "changedBy" AS by FROM ai_spend_cap_history WHERE email = $1 ORDER BY "changedAt", id`, [ANA])).rows;
    // Every change carries the same test clock, so compare without order.
    const changes = rows.map((r) => [r.old === null ? null : Number(r.old), r.new === null ? null : Number(r.new)]);
    expect(changes).toHaveLength(3);
    expect(changes).toEqual(expect.arrayContaining([[null, 15], [15, 20], [20, null]]));
    expect(rows.every((r) => r.by === ADMIN.email)).toBe(true);
    expect(await refusal(h.pg, `UPDATE ai_spend_cap_history SET "newCapUsd" = 1`)).not.toBeNull();
    expect(await refusal(h.pg, `DELETE FROM ai_spend_cap_history`)).not.toBeNull();
  });

  it("refuses non-admins, previews, bad emails and bad amounts, and saves nothing", async () => {
    expect(await set(ANA, "5", { email: BEN, isAdmin: false })).toEqual({ ok: false, error: AiSpendCopy.NOT_AUTHORIZED });
    expect(await set(ANA, "5", null)).toEqual({ ok: false, error: AiSpendCopy.NOT_AUTHORIZED });
    expect(await set(ANA, "5", ADMIN, { VERCEL_ENV: "preview" })).toEqual({ ok: false, error: AiSpendCopy.PREVIEW });
    expect(await set("not-an-email", "5")).toEqual({ ok: false, error: AiSpendCopy.INVALID_EMAIL });
    expect(await set(ANA, "-3")).toEqual({ ok: false, error: AiSpendCopy.INVALID_AMOUNT });
    expect(await AiSpendCapService.rows(db)).toEqual([]);
  });

  it("the database refuses what the app would never write", async () => {
    expect(await refusal(h.pg, `INSERT INTO ai_spend_caps (email, "monthlyCapUsd", "updatedBy") VALUES ('Upper@Example.test', 5, 'admin@example.test')`)).toMatch(/ai_spend_caps_email/);
    expect(await refusal(h.pg, `INSERT INTO ai_spend_caps (email, "monthlyCapUsd", "updatedBy") VALUES ('ana0@example.test', -1, 'admin@example.test')`)).toMatch(/ai_spend_caps_amount/);
    expect(await refusal(h.pg, `INSERT INTO ai_spend_caps (email, "monthlyCapUsd", "updatedBy") VALUES ('ana0@example.test', 10001, 'admin@example.test')`)).toMatch(/ai_spend_caps_amount/);
  });

  it("the admin view lists everyone who spent or has their own cap, highest spend first", async () => {
    await set("default", "10");
    await set(BEN, "3");
    await spend(ANA, 7.5);
    const v = await AiSpendCapService.view(db, NOW);
    expect(v.ready).toBe(true);
    expect(v.defaultCapUsd).toBe(10);
    const mine = v.people.filter((p) => p.email === ANA || p.email === BEN);
    expect(mine.map((p) => [p.email, p.spentUsd, p.ownCapUsd, p.effective.source])).toEqual([
      [ANA, 7.5, null, "default"],
      [BEN, 0, 3, "own"],
    ]);
  });
});

describe("before 0074 is applied (a preview on the production database)", () => {
  it("reads as no cap and a read-only card", async () => {
    const pg = await migratedPglite("0073_drive_connection");
    const port = 20000 + Math.floor(Math.random() * 20000);
    const server = new PGLiteSocketServer({ db: pg, port, host: "127.0.0.1", maxConnections: 4 });
    await server.start();
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`, max: 1 }) });
    try {
      const db = prisma as unknown as AiSpendCapReadDb;
      expect(await AiSpendCapService.check({ db, email: ANA, now })).toEqual({ ok: true });
      expect(await AiSpendCapService.rows(db)).toEqual([]);
      const v = await AiSpendCapService.view(db, NOW);
      expect(v.ready).toBe(false);
    } finally {
      await prisma.$disconnect();
      await server.stop();
      await pg.close();
    }
  });

  it("any other read error fails closed", async () => {
    const db = { aiSpendCap: { findMany: async () => { throw new Error("connection lost"); } } };
    expect(await AiSpendCapService.check({ db, email: ANA, now })).toEqual({ ok: false, reason: "error", message: AiSpendCopy.CHECK_FAILED });
  });
});

describe("the writing assistant stops at the cap without calling the provider", () => {
  it("returns kind cap and makes no provider call", async () => {
    const ENV = { AI_SETTINGS_ENCRYPTION_KEY: randomBytes(32).toString("base64") };
    const API_KEY = "sk-example-not-a-real-key-0000000000";
    const key = AiKeyCipher.fromEnv(ENV);
    if (!key.ok) throw new Error("test key");
    const fake = new FakeAiDb();
    fake.settings = {
      id: "ai", enabled: true, provider: "openai", model: "gpt-6-luna", baseUrl: null, azureEndpoint: null, azureDeployment: null,
      apiKeyCiphertext: AiKeyCipher.encrypt(API_KEY, key.key), apiKeyLast4: AiKeyCipher.last4(API_KEY), apiKeySetAt: NOW, apiKeySetBy: ADMIN.email, updatedAt: NOW, updatedBy: ADMIN.email,
    };
    const db = Object.assign(fake, {
      aiSpendCap: { findMany: async () => [{ email: "default", monthlyCapUsd: "1.00", updatedAt: NOW, updatedBy: ADMIN.email }] },
    });
    Object.assign(db.aiUsageLog, { aggregate: async () => ({ _sum: { costUsd: "1.25" } }) });
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls++;
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: "OK" } }] }) };
    };
    const r = await AiWritingService.suggest({ db, viewer: ADMIN, scope: ServiceLine.defaultScope(), projectId: null, feature: "draft_from_bullets", text: "example notes", env: ENV, fetchImpl, now });
    expect(r).toEqual({ ok: false, kind: "cap", message: AiSpendCopy.reached(1, "December 1") });
    expect(calls).toBe(0);
  });
});
