import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { AiDenied, type AiDeniedCaller } from "@/lib/ai/AiDenied";
import { AiDeniedService, type AiDeniedDb, type AiDeniedTx } from "@/lib/services/AiDeniedService";
import { registryHarness, type RegistryHarness } from "./helpers/PgRegistryDb";

// Item 10a, cron option (b): the denied-attempt counter, the live history list, the atomic fold, the first denial's own row,
// bounded keys, and the static guard that nothing under the cron routes or AiRetentionService was touched.
// Gates CG1, CG2 and CG3. Real Prisma client over an in-memory PGlite socket (127.0.0.1, random port). Fictional people only.
// Key-shaped fixtures are built from fragments at run time.
const j = (...parts: string[]) => parts.join("");
const OWNER: Viewer = { email: "jordan.pike@example.org", isAdmin: true };
const OTHER_ADMIN: Viewer = { email: "casey.lund@example.org", isAdmin: true };

const T0 = new Date("2026-10-28T14:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);
const W = AiDenied.WINDOW_MS;
const person = (email: string): AiDeniedCaller => ({ kind: "person", email });

let h: RegistryHarness;
let db: AiDeniedDb;
beforeAll(async () => {
  h = await registryHarness();
  db = h.prisma as unknown as AiDeniedDb;
});
afterAll(async () => { await h.stop(); });
afterEach(() => { vi.restoreAllMocks(); });

/** Everything the books hold for one person: history rows (denied and folded), the counter row, and the attempts they stand for. */
async function books(who: string, action?: string, prisma: RegistryHarness["prisma"] = h.prisma) {
  const rows = await prisma.aiSettingsHistory.findMany({ where: { field: AiDeniedService.FIELD, changedBy: who, ...(action ? { newValue: { startsWith: action } } : {}) }, orderBy: [{ changedAt: "asc" }, { id: "asc" }] });
  const counters = await prisma.aiDeniedCounter.findMany({ where: { who, ...(action ? { action } : {}) } });
  const firstRows = rows.filter((r) => r.action === AiDeniedService.ACTION_FIRST).length;
  const folded = rows.filter((r) => r.action === AiDeniedService.ACTION_FOLDED).reduce((n, r) => n + Number(/: (\d+) more/.exec(r.newValue ?? "")?.[1] ?? 0), 0);
  const live = counters.reduce((n, c) => n + c.count, 0);
  return { rows, counters, firstRows, folded, live, accounted: firstRows + folded + live };
}

/** A db whose transactions hand the service a wrapped transaction client. The wrapper can fail a call or run another denial first. */
function wrappedDb(wrap: (tx: AiDeniedTx) => AiDeniedTx): AiDeniedDb {
  return {
    ...(h.prisma as object),
    $transaction: (fn: (tx: AiDeniedTx) => Promise<unknown>) => h.prisma.$transaction(async (tx) => fn(wrap(tx as unknown as AiDeniedTx))),
  } as unknown as AiDeniedDb;
}

describe("AiDenied: the bounded vocabulary (no text from a caller becomes a key)", () => {
  it("who is one of four fixed labels or a lowercased email", () => {
    expect(AiDenied.who({ kind: "signed_out" })).toBe("signed out");
    expect(AiDenied.who({ kind: "agent" })).toBe("agent");
    expect(AiDenied.who({ kind: "voice_ticket" })).toBe("voice ticket");
    expect(AiDenied.who(person("  Riley.Moss@Example.ORG "))).toBe("riley.moss@example.org");
  });

  it("an email that is not a plausible address counts as signed out, and so does one over 254 characters", () => {
    expect(AiDenied.who(person(""))).toBe("signed out");
    expect(AiDenied.who(person("two words@example.org"))).toBe("signed out");
    expect(AiDenied.who(person("no-at-sign"))).toBe("signed out");
    expect(AiDenied.who(person(`${"a".repeat(250)}@example.org`))).toBe("signed out");
    expect(AiDenied.who({ kind: "person", email: undefined as unknown as string })).toBe("signed out");
  });

  it("an action is on the list or counts under one shared unknown label; every label passes the database shape rule", () => {
    expect(AiDenied.action("key_rotate")).toBe("key_rotate");
    expect(AiDenied.action("made up by a caller")).toBe(AiDenied.UNKNOWN_ACTION);
    for (const a of [...AiDenied.ACTIONS, AiDenied.UNKNOWN_ACTION]) expect(a).toMatch(/^[a-z0-9_.:-]{1,80}$/);
    expect(new Set(AiDenied.ACTIONS).size).toBe(AiDenied.ACTIONS.length);
  });
});

describe("recording one denial", () => {
  it("the first denial opens a window and writes its own history row at once: who, action and time", async () => {
    const who = "first.timer@example.org";
    const r = await AiDeniedService.record(db, person(who), "key_add", T0);
    expect(r).toEqual({ ok: true, outcome: "first_in_window", folded: 0 });
    const b = await books(who);
    expect(b.rows).toHaveLength(1);
    expect(b.rows[0]).toMatchObject({ field: "aiDenied", action: "denied", newValue: "key_add", changedBy: who });
    expect(b.rows[0].changedAt.toISOString()).toBe(T0.toISOString());
    expect(b.counters).toEqual([{ who, action: "key_add", windowStartedAt: T0, count: 0 }]);
  });

  it("a second denial in the window writes no history row and adds one to the counter", async () => {
    const who = "second.timer@example.org";
    await AiDeniedService.record(db, person(who), "key_add", T0);
    const r = await AiDeniedService.record(db, person(who), "key_add", at(5_000));
    expect(r).toEqual({ ok: true, outcome: "counted", folded: 0 });
    const b = await books(who);
    expect(b.rows).toHaveLength(1);
    expect(b.counters[0].count).toBe(1);
    expect(b.counters[0].windowStartedAt.toISOString()).toBe(T0.toISOString());
  });

  it("the window edge: 1 ms before the end still counts, exactly at the end opens a new window and folds", async () => {
    const who = "edge.case@example.org";
    await AiDeniedService.record(db, person(who), "cap_set", T0);
    await AiDeniedService.record(db, person(who), "cap_set", at(W - 1));
    const edge = await AiDeniedService.record(db, person(who), "cap_set", at(W));
    expect(edge).toEqual({ ok: true, outcome: "folded_and_new_window", folded: 1 });
    const b = await books(who);
    expect(b.rows.map((r) => r.action).sort()).toEqual(["denied", "denied", "denied_folded"]);
    expect(b.rows.find((r) => r.action === "denied_folded")?.newValue).toBe(`cap_set: 1 more denied attempt since ${T0.toISOString()}`);
    expect(b.counters[0]).toMatchObject({ count: 0 });
    expect(b.counters[0].windowStartedAt.toISOString()).toBe(at(W).toISOString());
  });

  it("a new window with nothing to fold writes only the new first-denial row", async () => {
    const who = "quiet.person@example.org";
    await AiDeniedService.record(db, person(who), "model_add", T0);
    const r = await AiDeniedService.record(db, person(who), "model_add", at(W + 1));
    expect(r).toEqual({ ok: true, outcome: "folded_and_new_window", folded: 0 });
    expect((await books(who)).rows.map((x) => x.action)).toEqual(["denied", "denied"]);
  });

  it("each person and each action has their own window and counter", async () => {
    const a = "pair.one@example.org";
    const b = "pair.two@example.org";
    await AiDeniedService.record(db, person(a), "key_add", T0);
    await AiDeniedService.record(db, person(b), "key_add", at(1000));
    await AiDeniedService.record(db, person(a), "key_remove", at(2000));
    expect((await books(a)).rows).toHaveLength(2);
    expect((await books(b)).rows).toHaveLength(1);
    expect((await books(a)).live + (await books(b)).live).toBe(0);
  });

  it("agent, voice ticket and signed-out callers are counted under their fixed labels", async () => {
    await AiDeniedService.record(db, { kind: "agent" }, "price_edit", T0);
    await AiDeniedService.record(db, { kind: "voice_ticket" }, "price_edit", T0);
    await AiDeniedService.record(db, { kind: "signed_out" }, "price_edit", T0);
    const rows = await h.prisma.aiDeniedCounter.findMany({ where: { action: "price_edit" }, orderBy: { who: "asc" } });
    expect(rows.map((r) => r.who)).toEqual(["agent", "signed out", "voice ticket"]);
  });

  it("never throws: a database failure gives ok false and logs only the error name", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = { $transaction: async () => { throw new Error("connection string with a secret-looking word"); } } as unknown as AiDeniedDb;
    expect(await AiDeniedService.record(broken, person("x@example.org"), "key_add", T0)).toEqual({ ok: false });
    expect(spy).toHaveBeenCalledWith("Denied attempt not recorded", "Error");
    expect(JSON.stringify(spy.mock.calls)).not.toMatch(/secret-looking/);
  });
});

describe("CG1: the Owner's history list shows every counter that has not folded yet", () => {
  it("every unfolded counter is shown with no job run, including one for a person who never retries; reading changes nothing", async () => {
    const fresh = await registryHarness();
    try {
      const d = fresh.prisma as unknown as AiDeniedDb;
      // A denied twice (counter 1) and never again; B denied 4 times (counter 3); C once (counter 0, only the first row); D another action.
      for (let i = 0; i < 2; i++) await AiDeniedService.record(d, person("a.person@example.org"), "key_add", at(i * 1000));
      for (let i = 0; i < 4; i++) await AiDeniedService.record(d, person("b.person@example.org"), "key_add", at(i * 1000));
      await AiDeniedService.record(d, person("c.person@example.org"), "key_add", at(500));
      for (let i = 0; i < 3; i++) await AiDeniedService.record(d, { kind: "agent" }, "kill_switch", at(i * 1000));
      const before = JSON.stringify(await fresh.prisma.aiDeniedCounter.findMany({ orderBy: [{ who: "asc" }, { action: "asc" }] }));

      const r = await AiDeniedService.historyWithLive(d, OWNER);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const live = r.entries.filter((e) => e.kind === "live");
      expect(live.map((e) => (e.kind === "live" ? `${e.who}|${e.action}|${e.count}` : ""))).toEqual(expect.arrayContaining(["a.person@example.org|key_add|1", "b.person@example.org|key_add|3", "agent|kill_switch|2"]));
      expect(live).toHaveLength(3); // C has nothing unfolded: its single denial is its history row
      const a = live.find((e) => e.kind === "live" && e.who === "a.person@example.org");
      expect(a && a.kind === "live" ? a.text : "").toBe(`1 more denied attempt since ${T0.toISOString()}`);
      // The first-denial rows are in the list too.
      expect(r.entries.filter((e) => e.kind === "history" && e.action === "denied")).toHaveLength(4);
      // The live lines come first, and reading folded and reset nothing.
      expect(r.entries.slice(0, 3).every((e) => e.kind === "live")).toBe(true);
      expect(JSON.stringify(await fresh.prisma.aiDeniedCounter.findMany({ orderBy: [{ who: "asc" }, { action: "asc" }] }))).toBe(before);
    } finally {
      await fresh.stop();
    }
  });

  it("no unfolded counter is ever dropped: 60 of them all show, even with the history limit at 1", async () => {
    const fresh = await registryHarness();
    try {
      const d = fresh.prisma as unknown as AiDeniedDb;
      for (let n = 0; n < 60; n++) {
        const who = `person.${String(n).padStart(2, "0")}@example.org`;
        await AiDeniedService.record(d, person(who), AiDenied.ACTIONS[n % AiDenied.ACTIONS.length], at(n));
        await AiDeniedService.record(d, person(who), AiDenied.ACTIONS[n % AiDenied.ACTIONS.length], at(n + 1));
      }
      const r = await AiDeniedService.historyWithLive(d, OWNER, { limit: 1 });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.entries.filter((e) => e.kind === "live")).toHaveLength(60);
      expect(r.entries.filter((e) => e.kind === "history")).toHaveLength(1);
      const total = r.entries.reduce((n, e) => n + (e.kind === "live" ? e.count : 0), 0);
      expect(total).toBe(60);
    } finally {
      await fresh.stop();
    }
  });

  it("a counter that folds leaves the live list and appears as a history row, so the count is visible before and after", async () => {
    const fresh = await registryHarness();
    try {
      const d = fresh.prisma as unknown as AiDeniedDb;
      const who = "fold.watcher@example.org";
      for (let i = 0; i < 5; i++) await AiDeniedService.record(d, person(who), "fallback_set", at(i));
      const live1 = await AiDeniedService.historyWithLive(d, OWNER);
      expect(live1.ok && live1.entries.some((e) => e.kind === "live" && e.count === 4)).toBe(true);
      await AiDeniedService.record(d, person(who), "fallback_set", at(W + 10));
      const live2 = await AiDeniedService.historyWithLive(d, OWNER);
      expect(live2.ok).toBe(true);
      if (!live2.ok) return;
      expect(live2.entries.filter((e) => e.kind === "live")).toHaveLength(0);
      const foldedRow = live2.entries.find((e) => e.kind === "history" && e.action === "denied_folded");
      expect(foldedRow && foldedRow.kind === "history" ? foldedRow.newValue : "").toBe(`fallback_set: 4 more denied attempts since ${T0.toISOString()}`);
    } finally {
      await fresh.stop();
    }
  });

  it("the list is Owner only: another admin, a viewer, an agent-style actor and a signed-out caller get nothing, and the database is not touched", async () => {
    const touched: string[] = [];
    const untouchable = new Proxy({}, { get: (_t, k) => { touched.push(String(k)); throw new Error("touched"); } }) as unknown as AiDeniedDb;
    for (const actor of [OTHER_ADMIN, { email: "riley.moss@example.org", isAdmin: false }, { email: OWNER.email, isAdmin: false }, null, undefined]) {
      expect(await AiDeniedService.historyWithLive(untouchable, actor)).toEqual({ ok: false, error: AiDeniedService.NOT_AUTHORIZED });
    }
    expect(touched).toEqual([]);
  });

  it("no counter is reset without a history row: over 400 random denials the books balance after every step, and a counter only drops with a folded row", async () => {
    const fresh = await registryHarness();
    try {
      const d = fresh.prisma as unknown as AiDeniedDb;
      let seed = 20261028;
      const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
      const people = ["p.one@example.org", "p.two@example.org", "p.three@example.org"];
      const actions = ["key_add", "cap_set", "step_up"];
      const made = new Map<string, number>();
      let clock = 0;
      for (let step = 0; step < 400; step++) {
        const who = people[Math.floor(rnd() * people.length)];
        const action = actions[Math.floor(rnd() * actions.length)];
        clock += Math.floor(rnd() * (W / 2)); // time only moves forward; about every third pair of steps opens a new window
        const key = `${who}|${action}`;
        const beforeCounter = await fresh.prisma.aiDeniedCounter.findUnique({ where: { who_action: { who, action } } });
        const beforeFolded = await fresh.prisma.aiSettingsHistory.count({ where: { action: "denied_folded", changedBy: who, newValue: { startsWith: action } } });
        const r = await AiDeniedService.record(d, person(who), action, at(clock));
        expect(r.ok).toBe(true);
        made.set(key, (made.get(key) ?? 0) + 1);
        const afterCounter = await fresh.prisma.aiDeniedCounter.findUnique({ where: { who_action: { who, action } } });
        const afterFolded = await fresh.prisma.aiSettingsHistory.count({ where: { action: "denied_folded", changedBy: who, newValue: { startsWith: action } } });
        if (beforeCounter && afterCounter && afterCounter.count < beforeCounter.count) expect(afterFolded).toBe(beforeFolded + 1);
        if (beforeCounter && afterCounter && afterCounter.windowStartedAt.getTime() !== beforeCounter.windowStartedAt.getTime() && beforeCounter.count > 0) expect(afterFolded).toBe(beforeFolded + 1);
        const b = await books(who, action, fresh.prisma);
        expect(b.accounted).toBe(made.get(key));
      }
      for (const [key, n] of made) {
        const [who, action] = key.split("|");
        expect((await books(who, action, fresh.prisma)).accounted).toBe(n);
      }
    } finally {
      await fresh.stop();
    }
  });
});

describe("CG2: the fold is atomic", () => {
  // PGlite holds ONE connection, so these tests cannot run two transactions at the same time. They interleave two logical
  // transactions by hand (the second one runs between two statements of the first, on the same connection) and prove the
  // ARITHMETIC: history rows summed + live counter = attempts made. They do NOT prove true parallelism. A real two-connection
  // test needs a Neon branch, run by Nick or QA.

  it("a failed fold changes neither the counter nor the history, and is not retried", async () => {
    const who = "failing.fold@example.org";
    for (let i = 0; i < 6; i++) await AiDeniedService.record(db, person(who), "key_rotate", at(i));
    const before = await books(who);
    expect(before.live).toBe(5);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    let historyCalls = 0;
    const failing = wrappedDb((tx) => ({
      aiDeniedCounter: tx.aiDeniedCounter,
      aiSettingsHistory: new Proxy(tx.aiSettingsHistory, { get: (t, k) => (k === "create" ? async () => { historyCalls++; throw new Error("injected failure"); } : Reflect.get(t, k)) }),
    }));
    const r = await AiDeniedService.record(failing, person(who), "key_rotate", at(W + 5));
    expect(r).toEqual({ ok: false });
    expect(historyCalls).toBe(1); // tried once, not retried
    expect(spy).toHaveBeenCalledTimes(1);
    const after = await books(who);
    expect(after.counters).toEqual(before.counters); // counter row exactly as it was: same window, same count
    expect(after.rows.map((x) => x.id)).toEqual(before.rows.map((x) => x.id));
    expect(after.accounted).toBe(before.accounted);
  });

  it("a failed first denial leaves no counter row behind", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const who = "failing.first@example.org";
    const failing = wrappedDb((tx) => ({
      aiDeniedCounter: tx.aiDeniedCounter,
      aiSettingsHistory: new Proxy(tx.aiSettingsHistory, { get: (t, k) => (k === "create" ? async () => { throw new Error("injected failure"); } : Reflect.get(t, k)) }),
    }));
    expect(await AiDeniedService.record(failing, person(who), "key_add", T0)).toEqual({ ok: false });
    expect((await books(who)).counters).toEqual([]);
    expect((await books(who)).rows).toEqual([]);
  });

  /**
   * Run `other` (a full second denial, on the same connection and the same transaction client) just before the first fold's
   * guarded reset. On one connection this is the only way to put a second writer between two statements of the first. It is
   * what READ COMMITTED would show the first transaction if the second had committed in that gap.
   */
  function interleaved(other: (tx: AiDeniedTx) => Promise<unknown>): AiDeniedDb {
    let fired = false;
    return wrappedDb((tx) => ({
      aiSettingsHistory: tx.aiSettingsHistory,
      aiDeniedCounter: new Proxy(tx.aiDeniedCounter, {
        get: (t, k) => {
          if (k !== "updateMany") return Reflect.get(t, k);
          return async (args: { data: { windowStartedAt?: Date } }) => {
            if (!fired && args.data.windowStartedAt) { fired = true; await other(tx); }
            return (t as unknown as { updateMany: (a: unknown) => Promise<unknown> }).updateMany(args);
          };
        },
      }),
    }));
  }

  it("interleaving 1: two denials both find the window over; the second finishes its fold first. Nothing lost, nothing doubled", async () => {
    const who = "race.fold@example.org";
    for (let i = 0; i < 6; i++) await AiDeniedService.record(db, person(who), "cap_revert", at(i)); // 1 first row + counter 5 = 6 attempts
    let attempts = 6;
    const t1 = at(W + 1000);
    const t2 = at(W + 2000);
    const d1 = interleaved(async (tx) => {
      // Transaction 2 runs completely between transaction 1's read and its reset.
      await AiDeniedService.recordIn(tx, who, "cap_revert", t2);
    });
    const r1 = await AiDeniedService.record(d1, person(who), "cap_revert", t1);
    attempts += 2;
    expect(r1.ok).toBe(true);
    const b = await books(who);
    expect(b.accounted).toBe(attempts);
    // The old window folded exactly once (5), and the 5 is not in the counter any more.
    const foldedRows = b.rows.filter((x) => x.action === "denied_folded");
    expect(foldedRows).toHaveLength(1);
    expect(foldedRows[0].newValue).toBe(`cap_revert: 5 more denied attempts since ${T0.toISOString()}`);
    // Transaction 2 opened the new window (its own first row); transaction 1 lost the race and added to it.
    expect(b.live).toBe(1);
    expect(b.firstRows).toBe(2);
  });

  it("interleaving 2: a denial is added to the old window after the fold read it. The fold notices, starts again and folds the larger count", async () => {
    const who = "race.count@example.org";
    for (let i = 0; i < 6; i++) await AiDeniedService.record(db, person(who), "model_restore", at(i)); // counter 5, window opened at T0
    const d1 = interleaved(async (tx) => {
      // A slow caller whose clock still sits inside the old window adds its denial between the read and the reset.
      await AiDeniedService.recordIn(tx, who, "model_restore", at(W - 1000));
    });
    const r1 = await AiDeniedService.record(d1, person(who), "model_restore", at(W + 1000));
    expect(r1).toEqual({ ok: true, outcome: "folded_and_new_window", folded: 6 });
    const b = await books(who);
    expect(b.accounted).toBe(8);
    expect(b.rows.filter((x) => x.action === "denied_folded").map((x) => x.newValue)).toEqual([`model_restore: 6 more denied attempts since ${T0.toISOString()}`]);
    expect(b.live).toBe(0);
  });

  it("interleaving 3: five denials in a row, each interleaved with another, keep history summed + counter = attempts", async () => {
    const who = "race.many@example.org";
    let attempts = 0;
    let clock = 0;
    for (let round = 0; round < 5; round++) {
      clock += W + 100; // every round the window is over
      const t = at(clock);
      await AiDeniedService.record(db, person(who), "backfill_run", t); // the window opens (or folds the last one)
      attempts++;
      for (let i = 0; i < round + 1; i++) { await AiDeniedService.record(db, person(who), "backfill_run", at(clock + 10 + i)); attempts++; }
      clock += W + 100;
      const d = interleaved(async (tx) => { await AiDeniedService.recordIn(tx, who, "backfill_run", at(clock + 5)); });
      await AiDeniedService.record(d, person(who), "backfill_run", at(clock));
      attempts += 2;
      expect((await books(who)).accounted).toBe(attempts);
    }
  });

  it("the database keeps its own guard: a counter row cannot be deleted, and its count cannot go below zero", async () => {
    const who = "db.guard@example.org";
    await AiDeniedService.record(db, person(who), "key_add", T0);
    const del = await h.pg.query(`DELETE FROM ai_denied_counter WHERE who = $1`, [who]).then(() => "deleted", (e: Error) => e.message);
    expect(del).not.toBe("deleted");
    const neg = await h.pg.query(`UPDATE ai_denied_counter SET count = -1 WHERE who = $1`, [who]).then(() => "updated", (e: Error) => e.message);
    expect(neg).toMatch(/ai_denied_counter_count/);
  });
});

describe("CG3: the first denial, a flood, bounded keys", () => {
  it("1,000 denied calls in a minute leave one history row for the action, a live counter of 999, and the first denial visible", async () => {
    const fresh = await registryHarness();
    try {
      const d = fresh.prisma as unknown as AiDeniedDb;
      const who = "flood.test@example.org";
      for (let i = 0; i < 1000; i++) await AiDeniedService.record(d, person(who), "key_add", at(i * 50)); // 1,000 calls in 50 seconds
      const rows = await fresh.prisma.aiSettingsHistory.findMany({ where: { field: "aiDenied" } });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ action: "denied", newValue: "key_add", changedBy: who });
      expect(rows[0].changedAt.toISOString()).toBe(T0.toISOString()); // the first denial, written at once
      const counters = await fresh.prisma.aiDeniedCounter.findMany();
      expect(counters).toHaveLength(1);
      expect(counters[0].count).toBe(999);
      const list = await AiDeniedService.historyWithLive(d, OWNER);
      expect(list.ok).toBe(true);
      if (!list.ok) return;
      const live = list.entries.filter((e) => e.kind === "live");
      expect(live).toHaveLength(1);
      expect(live[0].kind === "live" && live[0].text).toBe(`999 more denied attempts since ${T0.toISOString()}`);
      expect(list.entries.filter((e) => e.kind === "history")).toHaveLength(1);
    } finally {
      await fresh.stop();
    }
  }, 120000);

  it("a flood cannot hide the first denial or fill the history table: the flood's later denials write no history row", async () => {
    const who = "flood.small@example.org";
    for (let i = 0; i < 40; i++) await AiDeniedService.record(db, person(who), "price_refresh", at(i));
    const b = await books(who);
    expect(b.rows).toHaveLength(1);
    expect(b.live).toBe(39);
  });

  it("keys are bounded to (person, action): 300 invented actions and 300 invented emails make no new key", async () => {
    const fresh = await registryHarness();
    try {
      const d = fresh.prisma as unknown as AiDeniedDb;
      for (let i = 0; i < 300; i++) {
        await AiDeniedService.record(d, { kind: "person", email: `not an address ${i}` }, `invented action ${i} ${"x".repeat(i % 7)}`, at(i));
      }
      await AiDeniedService.record(d, { kind: "agent" }, j("sk", "-FICTION", "88ab12cd", "EFGH0123"), at(400)); // a key-shaped "action" from a caller
      const counters = await fresh.prisma.aiDeniedCounter.findMany({ orderBy: { who: "asc" } });
      expect(counters.map((c) => `${c.who}|${c.action}`)).toEqual([`agent|${AiDenied.UNKNOWN_ACTION}`, `signed out|${AiDenied.UNKNOWN_ACTION}`]);
      // Every attempt is accounted for under those two keys, and the key-shaped text reached no row.
      const history = await fresh.prisma.aiSettingsHistory.findMany({ where: { field: "aiDenied" } });
      expect(JSON.stringify(history)).not.toMatch(/FICTION/);
      const total = history.length + counters.reduce((n, c) => n + c.count, 0);
      expect(total).toBe(301);
    } finally {
      await fresh.stop();
    }
  });

  it("the number of keys can never pass people x actions: every action on the list, for two people, is exactly 2 x the list", async () => {
    const fresh = await registryHarness();
    try {
      const d = fresh.prisma as unknown as AiDeniedDb;
      for (const who of ["bound.one@example.org", "bound.two@example.org"]) for (const a of AiDenied.ACTIONS) await AiDeniedService.record(d, person(who), a, T0);
      expect(await fresh.prisma.aiDeniedCounter.count()).toBe(2 * AiDenied.ACTIONS.length);
    } finally {
      await fresh.stop();
    }
  });

  it("the database refuses a counter key the app would never write (action shape, empty who, negative count)", async () => {
    const insert = (who: string, action: string, count = 0) => h.pg.query(`INSERT INTO ai_denied_counter (who, action, "windowStartedAt", count) VALUES ($1, $2, now(), $3)`, [who, action, count]).then(() => null, (e: Error) => e.message);
    expect(await insert("shape.check@example.org", "Has Spaces")).toMatch(/ai_denied_counter_action_shape/);
    expect(await insert("", "key_add")).toMatch(/ai_denied_counter_who_length/);
    expect(await insert("x@example.org", "key_add", -2)).toMatch(/ai_denied_counter_count/);
  });

  // The static guard (option (b) means no cron wiring at all). The pins are the sha256 of each file at origin/main 0c9edc6.
  // A later, approved edit to any of these files must move its pin in the same pull request, which is the point.
  const root = path.resolve(__dirname, "..");
  const sha = (rel: string) => createHash("sha256").update(readFileSync(path.join(root, rel))).digest("hex");
  const walk = (dir: string): string[] => readdirSync(path.join(root, dir)).flatMap((n) => (statSync(path.join(root, dir, n)).isDirectory() ? walk(`${dir}/${n}`) : [`${dir}/${n}`])).sort();
  const PINS: Record<string, string> = {
    "src/app/api/cron/ai-retention/route.ts": "e0718ab169486b839fdf9bf78a5bc1d81d2c2f87a958ba7f22a96fcaf5a9e323",
    "src/app/api/cron/freeze/route.ts": "8b22f32f17bc303f066b5ad3d5c69111e7ebc4f59948d24ecedd304b5280187a",
    "src/lib/services/AiRetentionService.ts": "07ec4debacf47012c7fdc9008380823c32684b6b86ebd34bd0587f56769d84ea",
  };
  const BASE = "0c9edc69e5e66c958707e3873a16a71daa33e108";

  it("static guard: the files under src/app/api/cron are exactly the two that exist at 0c9edc6, with the same content, and AiRetentionService.ts is unchanged", () => {
    expect(walk("src/app/api/cron")).toEqual(["src/app/api/cron/ai-retention/route.ts", "src/app/api/cron/freeze/route.ts"]);
    for (const [file, pin] of Object.entries(PINS)) expect(sha(file), file).toBe(pin);
  });

  it("static guard: when the base commit is in the checkout, git itself reports no change under src/app/api/cron, to AiRetentionService.ts, or to the cron schedule", () => {
    let out: string | null = null;
    try {
      execFileSync("git", ["cat-file", "-e", `${BASE}^{commit}`], { cwd: root, stdio: "ignore" });
      out = execFileSync("git", ["diff", "--name-only", BASE, "--", "src/app/api/cron", "src/lib/services/AiRetentionService.ts", "vercel.json"], { cwd: root, encoding: "utf8" });
    } catch {
      out = null; // a source archive or a shallow clone: the content pins above are the guard there
    }
    if (out === null) return;
    expect(out.trim()).toBe("");
  });

  it("static guard: the cron schedule lists the same three jobs as at 0c9edc6, and nothing for the counter", () => {
    const crons = (JSON.parse(readFileSync(path.join(root, "vercel.json"), "utf8")) as { crons: { path: string; schedule: string }[] }).crons;
    expect(crons).toEqual([
      { path: "/api/cron/ai-retention", schedule: "0 9 * * *" },
      { path: "/api/cron/freeze", schedule: "0 21 * * *" },
      { path: "/api/cron/freeze", schedule: "0 22 * * *" },
    ]);
  });

  it("static guard: no cron route and not the retention service imports or names the counter code, and the counter code imports no cron file", () => {
    const names = /AiDenied|ai_denied_counter|aiDeniedCounter/;
    for (const f of [...walk("src/app/api/cron"), "src/lib/services/AiRetentionService.ts"]) expect(readFileSync(path.join(root, f), "utf8"), f).not.toMatch(names);
    for (const f of ["src/lib/services/AiDeniedService.ts", "src/lib/ai/AiDenied.ts"]) {
      expect(existsSync(path.join(root, f))).toBe(true);
      const imports = readFileSync(path.join(root, f), "utf8").split("\n").filter((l) => /^\s*(import|export)\b.*\bfrom\b/.test(l));
      expect(imports.filter((l) => /app\/api\/cron|AiRetentionService/.test(l)), f).toEqual([]);
    }
  });
});
