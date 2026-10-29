import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@/generated/prisma/client";
import { AiDenied } from "@/lib/ai/AiDenied";
import { AiDeniedService, type AiDeniedDb } from "@/lib/services/AiDeniedService";

/**
 * Real-Postgres probe for the denied-attempt counter. SKIPPED unless BOTH are set in the environment:
 *   AI_DENIED_PROBE_DATABASE_URL     a Postgres URL (read from the environment only; this file holds no URL or secret)
 *   AI_DENIED_PROBE_THROWAWAY=yes    you confirm the database is a scratch or throwaway branch
 * It WRITES: both tables are append-only (the database refuses deletes), so the rows it adds stay in that database for good.
 * Never point it at a database that matters. It runs 200 denials at once over 20 connections and checks that none is lost.
 */
const url = process.env.AI_DENIED_PROBE_DATABASE_URL;
const on = Boolean(url) && process.env.AI_DENIED_PROBE_THROWAWAY === "yes";

describe.skipIf(!on)("denied counter on a real Postgres (opt-in, writes permanent rows)", () => {
  const prisma = on ? new PrismaClient({ adapter: new PrismaPg({ connectionString: url as string, max: 20 }) }) : (null as unknown as PrismaClient);
  const db = prisma as unknown as AiDeniedDb;
  afterAll(async () => { await prisma?.$disconnect(); });

  async function accounted(who: string, action: string): Promise<{ live: number; firstRows: number; folded: number; total: number }> {
    const counter = await prisma.aiDeniedCounter.findUnique({ where: { who_action: { who, action } } });
    const rows = await prisma.aiSettingsHistory.findMany({ where: { field: "aiDenied", changedBy: who } });
    const mine = rows.filter((r) => String(r.newValue).startsWith(`${action}`));
    const firstRows = mine.filter((r) => r.action === "denied").length;
    const folded = mine.filter((r) => r.action === "denied_folded").reduce((n, r) => n + Number(/: (\d+) more denied/.exec(String(r.newValue))?.[1] ?? 0), 0);
    const live = counter?.count ?? 0;
    return { live, firstRows, folded, total: live + firstRows + folded };
  }

  it("200 concurrent denials in one window: exactly one opens it and every other one is counted", async () => {
    const who = `probe.${Date.now()}.a@example.test`;
    const caller = { kind: "person", viewer: { email: who, isAdmin: false } } as const;
    const now = new Date();
    const results = await Promise.all(Array.from({ length: 200 }, () => AiDeniedService.record(db, caller, "price_refresh", now)));
    expect(results.every((r) => r.ok)).toBe(true);
    const a = await accounted(who, "price_refresh");
    expect(a.firstRows).toBe(1);
    expect(a.total).toBe(200);
  });

  it("100 + 100 concurrent denials either side of a window edge: every denial is accounted for", async () => {
    const who = `probe.${Date.now()}.b@example.test`;
    const caller = { kind: "person", viewer: { email: who, isAdmin: false } } as const;
    const t0 = new Date();
    const t1 = new Date(t0.getTime() + AiDenied.WINDOW_MS + 1000);
    const calls = Array.from({ length: 200 }, (_, i) => AiDeniedService.record(db, caller, "price_refresh", i % 2 ? t0 : t1));
    const results = await Promise.all(calls);
    expect(results.every((r) => r.ok)).toBe(true);
    expect((await accounted(who, "price_refresh")).total).toBe(200);
  });
});
