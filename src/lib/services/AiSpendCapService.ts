import { randomUUID } from "node:crypto";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { AiKeyCipher } from "@/lib/ai/AiKeyCipher";
import { AiSpendCap, AiSpendCopy, type AiEffectiveCap } from "@/lib/ai/AiSpendCap";

type Env = Record<string, string | undefined>;
type Amount = number | string | { toString(): string } | null;

export interface AiSpendCapRow {
  email: string;
  monthlyCapUsd: Amount;
  updatedAt: Date;
  updatedBy: string;
}

export interface AiSpendCapHistoryRow {
  id: string;
  email: string;
  oldCapUsd: number | null;
  newCapUsd: number | null;
  changedAt: Date;
  changedBy: string;
}

/** The slice of Prisma the cap reads (tests pass an in-memory fake or the real client over PGlite). */
export interface AiSpendCapReadDb {
  aiSpendCap: { findMany(args?: { where?: { email: { in: string[] } } }): Promise<AiSpendCapRow[]> };
  aiUsageLog: {
    aggregate(args: { where: { userEmail: string; createdAt: { gte: Date } }; _sum: { costUsd: true } }): Promise<{ _sum: { costUsd: Amount } }>;
    groupBy(args: { by: ["userEmail"]; where: { createdAt: { gte: Date } }; _sum: { costUsd: true } }): Promise<{ userEmail: string; _sum: { costUsd: Amount } }[]>;
  };
}

/** The write slice (Admin > AI settings > Monthly spend caps). */
export interface AiSpendCapTx {
  aiSpendCap: {
    findUnique(args: { where: { email: string } }): Promise<AiSpendCapRow | null>;
    upsert(args: { where: { email: string }; create: AiSpendCapRow; update: Omit<AiSpendCapRow, "email"> }): Promise<unknown>;
    deleteMany(args: { where: { email: string } }): Promise<{ count: number }>;
  };
  aiSpendCapHistory: { create(args: { data: AiSpendCapHistoryRow }): Promise<unknown> };
}
export interface AiSpendCapWriteDb extends AiSpendCapTx {
  $transaction<T>(fn: (tx: AiSpendCapTx) => Promise<T>): Promise<T>;
}

export type AiSpendCheck = { ok: true } | { ok: false; reason: "cap" | "error"; message: string };
export type AiSpendCapResult = { ok: true } | { ok: false; error: string };

export interface AiSpendPersonView {
  email: string;
  spentUsd: number;
  /** Their own cap, or null when they follow the default. */
  ownCapUsd: number | null;
  effective: AiEffectiveCap;
}
export interface AiSpendCapView {
  /** False when the 0074 tables are missing (a preview before merge): the card is read-only. */
  ready: boolean;
  defaultCapUsd: number | null;
  people: AiSpendPersonView[];
}

/**
 * Monthly AI spend caps (0074). The check runs before every AI call that costs money (writing assistant, review,
 * AI tools, dictation, voice chat), right after the per-minute rate check. With no cap rows it does nothing, so AI works
 * exactly as before until an admin sets a cap. Spend is the estimated cost already on ai_usage_log for this calendar
 * month in Eastern time. The check happens before the call, so the run that crosses the cap still finishes.
 */
export class AiSpendCapService {
  /** Prisma's "table does not exist" (P2021), or Postgres 42P01 from the driver adapter. */
  static isMissingTable(e: unknown): boolean {
    const err = e as { code?: unknown; cause?: { code?: unknown; originalCode?: unknown; kind?: unknown }; meta?: { code?: unknown } } | null;
    if (!err) return false;
    if (err.code === "P2021" || err.code === "42P01") return true;
    if (err.meta?.code === "42P01" || err.cause?.code === "42P01" || err.cause?.originalCode === "42P01" || err.cause?.kind === "TableDoesNotExist") return true;
    return false;
  }

  private static hasCapTable(db: unknown): db is AiSpendCapReadDb {
    const d = db as Partial<AiSpendCapReadDb> | null;
    return typeof d?.aiSpendCap?.findMany === "function";
  }

  /** May this person start another AI call? Fails closed on a read error once caps exist; a missing table means no cap. */
  static async check(args: { db: unknown; email: string; env?: Env; now?: () => Date }): Promise<AiSpendCheck> {
    const now = (args.now ?? (() => new Date()))();
    // Database adapters without the 0074 tables (older test fakes) have no caps to enforce.
    if (!AiSpendCapService.hasCapTable(args.db)) return { ok: true };
    const db = args.db;
    const email = args.email.trim().toLowerCase();
    let rows: AiSpendCapRow[];
    try {
      rows = await db.aiSpendCap.findMany({ where: { email: { in: [email, AiSpendCap.DEFAULT_KEY] } } });
    } catch (e) {
      // 0074 not applied yet (previews skip migrations): no cap exists, so nothing to enforce.
      if (AiSpendCapService.isMissingTable(e)) return { ok: true };
      console.error("AI spend cap: cap read failed", (e as Error)?.name);
      return { ok: false, reason: "error", message: AiSpendCopy.CHECK_FAILED };
    }
    const cap = AiSpendCapService.effectiveOf(rows, email).capUsd;
    if (cap === null) return { ok: true };
    let spent: number;
    try {
      if (typeof db.aiUsageLog?.aggregate !== "function") throw new Error("usage sum unavailable");
      const r = await db.aiUsageLog.aggregate({ where: { userEmail: email, createdAt: { gte: AiSpendCap.monthStart(now) } }, _sum: { costUsd: true } });
      spent = AiSpendCap.num(r._sum.costUsd) ?? 0;
    } catch (e) {
      console.error("AI spend cap: usage sum failed", (e as Error)?.name);
      return { ok: false, reason: "error", message: AiSpendCopy.CHECK_FAILED };
    }
    if (AiSpendCap.allows(cap, spent)) return { ok: true };
    return { ok: false, reason: "cap", message: AiSpendCopy.reached(cap, AiSpendCap.resetLabel(now)) };
  }

  /** The cap that applies to one email, from the rows read (their own and the default). */
  static effectiveOf(rows: readonly Pick<AiSpendCapRow, "email" | "monthlyCapUsd">[], email: string): AiEffectiveCap {
    const key = email.trim().toLowerCase();
    const own = rows.find((r) => r.email === key);
    const fallback = rows.find((r) => r.email === AiSpendCap.DEFAULT_KEY);
    return AiSpendCap.effective({ own: own ? AiSpendCap.num(own.monthlyCapUsd) : null, fallback: fallback ? AiSpendCap.num(fallback.monthlyCapUsd) : null });
  }

  /** Every cap row (People page and the admin card). A missing table reads as no caps. */
  static async rows(db: unknown): Promise<AiSpendCapRow[]> {
    if (!AiSpendCapService.hasCapTable(db)) return [];
    try {
      return await db.aiSpendCap.findMany();
    } catch (e) {
      if (AiSpendCapService.isMissingTable(e)) return [];
      throw e;
    }
  }

  /** Admin > AI settings > Monthly spend caps: the default and everyone who spent this month or has their own cap. */
  static async view(db: AiSpendCapReadDb, now: Date = new Date()): Promise<AiSpendCapView> {
    let rows: AiSpendCapRow[];
    let ready = true;
    try {
      rows = await db.aiSpendCap.findMany();
    } catch (e) {
      if (!AiSpendCapService.isMissingTable(e)) throw e;
      rows = [];
      ready = false;
    }
    const spend = await db.aiUsageLog.groupBy({ by: ["userEmail"], where: { createdAt: { gte: AiSpendCap.monthStart(now) } }, _sum: { costUsd: true } });
    const spent = new Map<string, number>();
    for (const s of spend) {
      const key = s.userEmail.trim().toLowerCase();
      spent.set(key, (spent.get(key) ?? 0) + (AiSpendCap.num(s._sum.costUsd) ?? 0));
    }
    const fallback = rows.find((r) => r.email === AiSpendCap.DEFAULT_KEY);
    const emails = new Set<string>([...spent.keys(), ...rows.map((r) => r.email).filter((e) => e !== AiSpendCap.DEFAULT_KEY)]);
    const people: AiSpendPersonView[] = [...emails].map((email) => {
      const own = rows.find((r) => r.email === email);
      return {
        email,
        spentUsd: Math.round((spent.get(email) ?? 0) * 1e6) / 1e6,
        ownCapUsd: own ? AiSpendCap.num(own.monthlyCapUsd) : null,
        effective: AiSpendCapService.effectiveOf(rows, email),
      };
    });
    people.sort((a, b) => b.spentUsd - a.spentUsd || a.email.localeCompare(b.email));
    return { ready, defaultCapUsd: fallback ? AiSpendCap.num(fallback.monthlyCapUsd) : null, people };
  }

  /**
   * Sets or removes one cap. target is an email or "default"; a blank amount removes the cap (the person follows the
   * default again, or there is no default). Admins only and never on a preview. One history row per
   * change; saving the same amount again writes nothing.
   */
  static async setCap(args: { db: AiSpendCapWriteDb; viewer: Pick<Viewer, "email" | "isAdmin"> | null; target: unknown; amount: unknown; env?: Env; now?: () => Date }): Promise<AiSpendCapResult> {
    const env = args.env ?? process.env;
    const now = (args.now ?? (() => new Date()))();
    if (!args.viewer?.isAdmin) return { ok: false, error: AiSpendCopy.NOT_AUTHORIZED };
    if (AiKeyCipher.isPreview(env)) return { ok: false, error: AiSpendCopy.PREVIEW };
    const target = args.target === AiSpendCap.DEFAULT_KEY ? AiSpendCap.DEFAULT_KEY : AiSpendCap.normalizeEmail(args.target);
    if (!target) return { ok: false, error: AiSpendCopy.INVALID_EMAIL };
    const amount = AiSpendCap.parseAmount(args.amount);
    if (amount === undefined) return { ok: false, error: AiSpendCopy.INVALID_AMOUNT };
    const actor = args.viewer.email.trim().toLowerCase();
    return args.db.$transaction(async (tx) => {
      const current = await tx.aiSpendCap.findUnique({ where: { email: target } });
      const before = current ? AiSpendCap.num(current.monthlyCapUsd) : null;
      if (before === amount) return { ok: true } as const;
      if (amount === null) await tx.aiSpendCap.deleteMany({ where: { email: target } });
      else await tx.aiSpendCap.upsert({ where: { email: target }, create: { email: target, monthlyCapUsd: amount, updatedAt: now, updatedBy: actor }, update: { monthlyCapUsd: amount, updatedAt: now, updatedBy: actor } });
      await tx.aiSpendCapHistory.create({ data: { id: randomUUID(), email: target, oldCapUsd: before, newCapUsd: amount, changedAt: now, changedBy: actor } });
      return { ok: true } as const;
    });
  }
}
