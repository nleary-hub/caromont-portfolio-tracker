import { randomUUID } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { OwnerPolicy } from "@/lib/auth/OwnerPolicy";
import { AiKeyShape } from "@/lib/ai/AiKeyShape";
import { AiDenied, type AiDeniedCaller } from "@/lib/ai/AiDenied";

type Env = Record<string, string | undefined>;

/** The slice of Prisma this service uses. A real PrismaClient or a PGlite-backed client fits. */
export type AiDeniedTx = Pick<Prisma.TransactionClient, "aiDeniedCounter" | "aiSettingsHistory">;
export interface AiDeniedDb extends AiDeniedTx {
  $transaction<T>(fn: (tx: AiDeniedTx) => Promise<T>, options?: { isolationLevel?: Prisma.TransactionIsolationLevel }): Promise<T>;
}

/** What one denial did to the books: written as its own row, added to the live counter, or folded and started a new window. */
export type AiDeniedOutcome = "first_in_window" | "counted" | "folded_and_new_window";

export type AiDeniedRecordResult = { ok: true; outcome: AiDeniedOutcome; folded: number } | { ok: false };

export type AiHistoryEntry =
  | { kind: "history"; id: string; field: string; action: string; oldValue: string | null; newValue: string | null; changedAt: Date; changedBy: string }
  | { kind: "live"; who: string; action: string; count: number; since: Date; text: string };

export type AiHistoryListResult = { ok: true; entries: AiHistoryEntry[] } | { ok: false; error: string };

/**
 * Denied attempts, option (b) (item 10a). The counter is written live to ai_denied_counter; the history list reads it live;
 * a count folds into a history row in one transaction when a new window opens. No cron route, no retention job and no
 * AiRetentionService change is involved, and no file under src/app/api/cron imports this one (a test pins that).
 *
 * The books balance at all times: history rows summed (a first-denial row counts 1, a folded row counts its N) plus the live
 * counters equals the attempts made. Nothing is lost and nothing is counted twice, because
 *   - the first denial of a window is a conditional insert, so exactly one caller wins it;
 *   - a further denial in the window is one UPDATE that adds one, so concurrent ones add up;
 *   - a fold is a conditional UPDATE that matches only the exact row state that was read (same window start, same count), in
 *     the same transaction as the history rows; a caller that lost the race starts again from the new state.
 * A failure of any step rolls the whole transaction back: counter and history change together or not at all. A failed
 * recording is not retried (only a lost race is repeated, a few times, because it did not fail).
 *
 * Not wired yet: nothing calls record or historyWithLive, and the Admin AI page does not read the live list. Item 10a, G10 and
 * A14 are met only for this library. The wiring goes in the later pull request that rewires the Admin AI page and the entry points.
 *
 * Keys: "action" comes from AiDenied's closed list (anything else is one shared label). "who" for a person is the verified
 * signed-in session user, and that is a PRECONDITION of the caller, not something this service can check: it must never be
 * given an address read from request input (pass signed_out instead). Under that precondition the rows are bounded by the
 * people who can sign in times the actions; without it every distinct address is a new permanent row. A key-shaped address is
 * stored as "signed out". Server only.
 */
export class AiDeniedService {
  static readonly FIELD = "aiDenied";
  static readonly ACTION_FIRST = "denied";
  static readonly ACTION_FOLDED = "denied_folded";
  /** A lost race is repeated at most this many times. Each loss means another caller made progress, so more than a few is not expected. */
  static readonly MAX_RACES = 8;
  static readonly NOT_AUTHORIZED = "Not authorized.";
  static readonly LIST_FAILED = "Could not load the history.";

  /**
   * Record one denied attempt. Anyone can be denied, so this takes no Owner check. It never throws and never changes the
   * answer the caller already gave: the result says whether the books were updated. A false result is logged by error name only.
   */
  static async record(db: AiDeniedDb, caller: AiDeniedCaller, action: string, now: Date = new Date()): Promise<AiDeniedRecordResult> {
    const who = AiDenied.who(caller);
    const act = AiDenied.action(action);
    try {
      return await db.$transaction((tx) => AiDeniedService.recordIn(tx, who, act, now));
    } catch (e) {
      console.error("Denied attempt not recorded", (e as Error)?.name);
      return { ok: false };
    }
  }

  /**
   * The body of one denial inside a transaction the caller owns. Exported for the tests, which run two of these against one
   * connection and interleave them by hand. Throws on any failure (the caller's transaction then rolls back).
   */
  static async recordIn(tx: AiDeniedTx, who: string, action: string, now: Date): Promise<AiDeniedRecordResult & { ok: true }> {
    const cutoff = new Date(now.getTime() - AiDenied.WINDOW_MS);
    for (let race = 0; race < AiDeniedService.MAX_RACES; race++) {
      // 1. No row yet for this person and action: this denial opens the first window and gets its own history row.
      const made = await tx.aiDeniedCounter.createMany({ data: [{ who, action, windowStartedAt: now, count: 0 }], skipDuplicates: true });
      if (made.count === 1) {
        await AiDeniedService.writeRow(tx, AiDeniedService.ACTION_FIRST, action, who, now);
        return { ok: true, outcome: "first_in_window", folded: 0 };
      }
      // 2. A window is open: add one. One UPDATE, so two callers at once both count.
      const added = await tx.aiDeniedCounter.updateMany({ where: { who, action, windowStartedAt: { gt: cutoff } }, data: { count: { increment: 1 } } });
      if (added.count === 1) return { ok: true, outcome: "counted", folded: 0 };
      // 3. The window is over. Fold what it counted and open a new one, but only if the row is still exactly as read.
      const row = await tx.aiDeniedCounter.findUnique({ where: { who_action: { who, action } } });
      if (!row) continue;
      const reset = await tx.aiDeniedCounter.updateMany({ where: { who, action, windowStartedAt: row.windowStartedAt, count: row.count }, data: { count: 0, windowStartedAt: now } });
      if (reset.count !== 1) continue; // someone else folded or added first: look again
      if (row.count > 0) await AiDeniedService.writeRow(tx, AiDeniedService.ACTION_FOLDED, AiDenied.foldedValue(action, row.count, row.windowStartedAt), who, now);
      await AiDeniedService.writeRow(tx, AiDeniedService.ACTION_FIRST, action, who, now);
      return { ok: true, outcome: "folded_and_new_window", folded: row.count };
    }
    throw new Error("DeniedCounterContention");
  }

  /** One settings-history row. The text is checked by the shared key detector first (G-APP); a refusal throws, rolling the transaction back. */
  private static async writeRow(tx: AiDeniedTx, action: string, newValue: string, who: string, at: Date): Promise<void> {
    if (AiKeyShape.historyValueProblem(newValue)) throw new Error("DeniedHistoryValueRefused");
    await tx.aiSettingsHistory.create({ data: { id: randomUUID(), field: AiDeniedService.FIELD, action, oldValue: null, newValue, changedAt: at, changedBy: who } });
  }

  /**
   * The Owner's history list: the newest history rows, with every counter that has not folded yet shown as a live line
   * ("N more denied attempts since <time>") above them. The counters are read at view time, in the same snapshot as the history
   * rows, so a fold that happens while the list is read cannot make a count vanish or show twice. The live lines are never
   * cut by `limit` (the table is bounded; a person who never retries still shows). Owner only.
   */
  static async historyWithLive(db: AiDeniedDb, actor: Viewer | null | undefined, opts: { limit?: number } = {}, env?: Env): Promise<AiHistoryListResult> {
    if (!OwnerPolicy.isOwner(actor, env)) return { ok: false, error: AiDeniedService.NOT_AUTHORIZED };
    const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 100) || 100, 1), 1000);
    try {
      return await db.$transaction(
        async (tx) => {
          const live = await tx.aiDeniedCounter.findMany({ where: { count: { gt: 0 } }, orderBy: [{ windowStartedAt: "desc" }, { who: "asc" }, { action: "asc" }] });
          const rows = await tx.aiSettingsHistory.findMany({ orderBy: [{ changedAt: "desc" }, { id: "asc" }], take: limit });
          const entries: AiHistoryEntry[] = [
            ...live.map((r) => ({ kind: "live" as const, who: r.who, action: r.action, count: r.count, since: r.windowStartedAt, text: AiDenied.moreText(r.count, r.windowStartedAt) })),
            ...rows.map((r) => ({ kind: "history" as const, id: r.id, field: r.field, action: r.action, oldValue: r.oldValue, newValue: r.newValue, changedAt: r.changedAt, changedBy: r.changedBy })),
          ];
          return { ok: true as const, entries };
        },
        { isolationLevel: "RepeatableRead" },
      );
    } catch (e) {
      console.error("History list failed", (e as Error)?.name);
      return { ok: false, error: AiDeniedService.LIST_FAILED };
    }
  }
}
