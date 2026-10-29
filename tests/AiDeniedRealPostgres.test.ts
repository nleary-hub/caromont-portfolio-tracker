import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@/generated/prisma/client";
import { AiDenied } from "@/lib/ai/AiDenied";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { AiDeniedService, type AiDeniedDb, type AiDeniedTx } from "@/lib/services/AiDeniedService";

/**
 * Real-Postgres probe for the denied-attempt counter. SKIPPED unless BOTH are set in the environment:
 *   AI_DENIED_PROBE_DATABASE_URL     a Postgres URL (read from the environment only; this file holds no URL or secret)
 *   AI_DENIED_PROBE_THROWAWAY=yes    you confirm the database is a scratch or throwaway branch
 * Besides the race checks it holds two deterministic ones: a fold that starts from an expired window, and a list read that a fold interrupts.
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

  it("100 + 100 concurrent denials either side of a window edge: the t1 batch folds the t0 window exactly once and every denial is accounted for", async () => {
    const who = `probe.${Date.now()}.b@example.test`;
    const caller = { kind: "person", viewer: { email: who, isAdmin: false } } as const;
    const t0 = new Date();
    const t1 = new Date(t0.getTime() + AiDenied.WINDOW_MS + 1000);
    // Barrier: the t0 batch runs (100 at once) and commits before any t1 call starts, so the t0 window is open when the t1
    // batch (100 at once) arrives after its end, and the t1 calls race to fold it.
    const before = await Promise.all(Array.from({ length: 100 }, () => AiDeniedService.record(db, caller, "price_refresh", t0)));
    const after = await Promise.all(Array.from({ length: 100 }, () => AiDeniedService.record(db, caller, "price_refresh", t1)));
    expect([...before, ...after].every((r) => r.ok)).toBe(true);
    const outcomes = (rs: typeof before) => rs.map((r) => (r.ok ? r.outcome : "failed")).sort();
    expect(outcomes(before)).toEqual([...Array(99).fill("counted"), "first_in_window"]);
    const folds = after.filter((r) => r.ok && r.outcome === "folded_and_new_window");
    expect(folds).toEqual([{ ok: true, outcome: "folded_and_new_window", folded: 99 }]);
    expect(after.filter((r) => r.ok && r.outcome === "counted")).toHaveLength(99);
    const foldRows = (await prisma.aiSettingsHistory.findMany({ where: { field: "aiDenied", changedBy: who, action: "denied_folded" } })).length;
    expect(foldRows).toBe(1);
    expect(await accounted(who, "price_refresh")).toEqual({ live: 99, firstRows: 2, folded: 99, total: 200 });
  });

  it("fold first (deterministic): one call after a window with 5 extras ended folds it, then 19 concurrent denials all count in the new window", async () => {
    const who = `probe.${Date.now()}.c@example.test`;
    const caller = { kind: "person", viewer: { email: who, isAdmin: false } } as const;
    const t0 = new Date();
    for (let i = 0; i < 6; i++) await AiDeniedService.record(db, caller, "price_refresh", t0); // one first row, counter 5
    const t1 = new Date(t0.getTime() + AiDenied.WINDOW_MS + 1000); // the window is over for every call below
    // Seed the new window first: this one call folds the 5 and opens the t1 window before the burst starts, so the 19 below
    // all race on the same step 2 increment. A non-atomic increment loses counts here (it does not depend on fold timing).
    const seed = await AiDeniedService.record(db, caller, "price_refresh", t1);
    expect(seed).toEqual({ ok: true, outcome: "folded_and_new_window", folded: 5 });
    const results = await Promise.all(Array.from({ length: 19 }, () => AiDeniedService.record(db, caller, "price_refresh", t1)));
    expect(results.map((r) => (r.ok ? r.outcome : "failed"))).toEqual(Array(19).fill("counted"));
    const a = await accounted(who, "price_refresh");
    expect(a).toEqual({ live: 19, firstRows: 2, folded: 5, total: 26 });
  });

  it("overlap (repeated, probabilistic): old-window and new-window calls in flight at once never lose or double a count", async () => {
    // Real traffic has no barrier: clock skew lets t0 and t1 calls arrive together. The split between the windows depends on
    // scheduling, so only split-independent invariants are asserted, over several iterations. This is a check, not a proof.
    for (let iter = 0; iter < 5; iter++) {
      const who = `probe.${Date.now()}.e${iter}@example.test`;
      const caller = { kind: "person", viewer: { email: who, isAdmin: false } } as const;
      const t0 = new Date();
      const t1 = new Date(t0.getTime() + AiDenied.WINDOW_MS + 1000);
      await AiDeniedService.record(db, caller, "price_refresh", t0); // seed the old window
      const results = await Promise.all(Array.from({ length: 200 }, (_, i) => AiDeniedService.record(db, caller, "price_refresh", i % 2 ? t1 : t0)));
      expect(results.every((r) => r.ok)).toBe(true);
      const folds = results.filter((r) => r.ok && r.outcome === "folded_and_new_window");
      expect(folds.length).toBeLessThanOrEqual(1); // only the t0 window can end here
      const foldRows = await prisma.aiSettingsHistory.findMany({ where: { field: "aiDenied", changedBy: who, action: "denied_folded" } });
      expect(foldRows.length).toBeLessThanOrEqual(1);
      const a = await accounted(who, "price_refresh");
      expect(a.live).toBeGreaterThanOrEqual(0);
      expect(a.folded).toBe(folds.reduce((n, r) => n + (r.ok ? r.folded : 0), 0)); // the fold row says what the fold result said
      expect(a.total).toBe(201); // the seed + 200: none lost, none counted twice
    }
  });

  it("the Owner's list is one snapshot: a fold that commits on another connection between the counter read and the history read cannot double a count", async () => {
    const owner: Viewer = { email: "jordan.pike@example.org", isAdmin: true };
    const who = `probe.${Date.now()}.d@example.test`;
    const caller = { kind: "person", viewer: { email: who, isAdmin: false } } as const;
    const t0 = new Date();
    for (let i = 0; i < 6; i++) await AiDeniedService.record(db, caller, "price_refresh", t0); // counter 5, one first row
    const t1 = new Date(t0.getTime() + AiDenied.WINDOW_MS + 1000);
    let folded = false;
    const hooked = {
      $transaction: (fn: (tx: AiDeniedTx) => Promise<unknown>, options?: unknown) =>
        (db as unknown as { $transaction: (f: (tx: AiDeniedTx) => Promise<unknown>, o?: unknown) => Promise<unknown> }).$transaction(
          (tx) =>
            fn({
              aiSettingsHistory: tx.aiSettingsHistory,
              aiDeniedCounter: new Proxy(tx.aiDeniedCounter, {
                get: (t, k) =>
                  k === "findMany"
                    ? async (args: unknown) => {
                        const r = await (t as unknown as { findMany: (a: unknown) => Promise<unknown> }).findMany(args);
                        if (!folded) { folded = true; await AiDeniedService.record(db, caller, "price_refresh", t1); } // commits on another connection
                        return r;
                      }
                    : Reflect.get(t, k),
              }),
            } as AiDeniedTx),
          options,
        ),
    } as unknown as AiDeniedDb;
    const r = await AiDeniedService.historyWithLive(hooked, owner, { limit: 1000 });
    expect(folded).toBe(true);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const mine = r.entries.filter((e) => (e.kind === "live" ? e.who : e.changedBy) === who);
    const live = mine.reduce((n, e) => n + (e.kind === "live" ? e.count : 0), 0);
    const first = mine.filter((e) => e.kind === "history" && e.action === "denied").length;
    const foldedSum = mine.reduce((n, e) => n + (e.kind === "history" && e.action === "denied_folded" ? Number(/: (\d+) more denied/.exec(String(e.newValue))?.[1] ?? 0) : 0), 0);
    // The snapshot is from before the fold: 5 live + 1 first row. A list that read the history after the fold would show 5 twice.
    expect({ live, first, foldedSum }).toEqual({ live: 5, first: 1, foldedSum: 0 });
    expect((await accounted(who, "price_refresh")).total).toBe(7); // the world after the fold: 6 + the one that folded
  });
});
