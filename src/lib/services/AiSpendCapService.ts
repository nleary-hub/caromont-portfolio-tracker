import { randomUUID } from "node:crypto";
import type { Viewer } from "@/lib/auth/AdminPolicy";
import { AiKeyCipher } from "@/lib/ai/AiKeyCipher";
import { AiSpendCap, AiSpendCopy, type AiSpendVendor } from "@/lib/ai/AiSpendCap";

type Env = Record<string, string | undefined>;
type Amount = number | string | { toString(): string } | null;

export interface AiProviderSpendRow {
  provider: string;
  monthlyCapUsd: Amount;
  updatedAt: Date;
  updatedBy: string;
}

export interface AiProviderSpendHistoryRow {
  id: string;
  provider: string;
  oldCapUsd: number | null;
  newCapUsd: number | null;
  note: string | null;
  changedAt: Date;
  changedBy: string;
}

/** A kept per-person row from 0074. Read for the settings page, never for enforcement. */
export interface AiSpendCapRow {
  email: string;
  monthlyCapUsd: Amount;
  updatedAt: Date;
  updatedBy: string;
}

interface UsageGroup {
  provider: string | null;
  model: string | null;
  _sum: { costUsd: Amount };
}

/** The slice of Prisma the cap reads. */
export interface AiSpendCapReadDb {
  aiProviderSpendCap: { findMany(): Promise<AiProviderSpendRow[]> };
  aiSpendCap?: { findMany(): Promise<AiSpendCapRow[]> };
  aiModel?: { findMany(args?: { orderBy?: { id: "asc" } }): Promise<{ id: string; provider: string }[]> };
  aiUsageLog: {
    groupBy(args: { by: ["provider", "model"]; where: { createdAt: { gte: Date } }; _sum: { costUsd: true } }): Promise<UsageGroup[]>;
  };
}

export interface AiSpendCapTx {
  aiProviderSpendCap: {
    findUnique(args: { where: { provider: string } }): Promise<AiProviderSpendRow | null>;
    upsert(args: { where: { provider: string }; create: AiProviderSpendRow; update: Omit<AiProviderSpendRow, "provider"> }): Promise<unknown>;
    deleteMany(args: { where: { provider: string } }): Promise<{ count: number }>;
  };
  aiProviderSpendCapHistory: { create(args: { data: AiProviderSpendHistoryRow }): Promise<unknown> };
}
export interface AiSpendCapWriteDb extends AiSpendCapTx {
  $transaction<T>(fn: (tx: AiSpendCapTx) => Promise<T>): Promise<T>;
}

export type AiSpendCheck = { ok: true } | { ok: false; reason: "cap" | "error"; message: string };
export type AiSpendCapResult = { ok: true } | { ok: false; error: string };

export interface AiProviderSpendView {
  provider: AiSpendVendor;
  label: string;
  spentUsd: number;
  capUsd: number | null;
}
export interface AiPreviousPersonCap {
  email: string;
  capUsd: number;
}
export interface AiSpendCapView {
  /** False when the 0075 table is missing (a preview before merge): the card is read-only. */
  ready: boolean;
  providers: AiProviderSpendView[];
  /** Old per-person amounts, kept and shown, not enforced. */
  previousPeople: AiPreviousPersonCap[];
  /** The old default per-person cap, if one was saved. */
  previousDefaultUsd: number | null;
}

/**
 * Monthly AI spend caps, one shared total per company (0075). The check runs before every AI call that costs money.
 * With no cap row for that company it does nothing. Spend is estimated cost already on ai_usage_log for this calendar
 * month in Eastern time, summed across everyone. A usage row with no company counts toward OpenAI. The check happens
 * before the call, so the run that crosses the cap still finishes.
 *
 * The 0074 per-person rows stay in ai_spend_caps. They are shown on the settings page and are not enforced.
 */
export class AiSpendCapService {
  static isMissingTable(e: unknown): boolean {
    const err = e as { code?: unknown; cause?: { code?: unknown; originalCode?: unknown; kind?: unknown }; meta?: { code?: unknown } } | null;
    if (!err) return false;
    if (err.code === "P2021" || err.code === "42P01") return true;
    if (err.meta?.code === "42P01" || err.cause?.code === "42P01" || err.cause?.originalCode === "42P01" || err.cause?.kind === "TableDoesNotExist") return true;
    return false;
  }

  private static hasCapTable(db: unknown): db is AiSpendCapReadDb {
    const d = db as Partial<AiSpendCapReadDb> | null;
    return typeof d?.aiProviderSpendCap?.findMany === "function";
  }

  /** May anyone start another call to this company? Fails closed on a read error once the table exists; a missing table means no cap. */
  static async check(args: { db: unknown; provider?: string; email?: string; env?: Env; now?: () => Date }): Promise<AiSpendCheck> {
    const now = (args.now ?? (() => new Date()))();
    if (!AiSpendCapService.hasCapTable(args.db)) return { ok: true };
    const db = args.db;
    const vendor = AiSpendCap.parseVendor(args.provider) ?? AiSpendCap.vendorOf({ provider: args.provider ?? "openai" });
    let rows: AiProviderSpendRow[];
    try {
      rows = await db.aiProviderSpendCap.findMany();
    } catch (e) {
      if (AiSpendCapService.isMissingTable(e)) return { ok: true };
      console.error("AI spend cap: cap read failed", (e as Error)?.name);
      return { ok: false, reason: "error", message: AiSpendCopy.CHECK_FAILED };
    }
    const row = rows.find((r) => r.provider === vendor);
    const cap = row ? AiSpendCap.num(row.monthlyCapUsd) : null;
    if (cap === null) return { ok: true };
    let spent: number;
    try {
      spent = await AiSpendCapService.spent(db, vendor, now);
    } catch (e) {
      console.error("AI spend cap: usage sum failed", (e as Error)?.name);
      return { ok: false, reason: "error", message: AiSpendCopy.CHECK_FAILED };
    }
    if (AiSpendCap.allows(cap, spent)) return { ok: true };
    return { ok: false, reason: "cap", message: AiSpendCopy.reached(AiSpendCap.label(vendor), cap, AiSpendCap.resetLabel(now)) };
  }

  /** Estimated cost this month for one company, across everyone. */
  static async spent(db: AiSpendCapReadDb, vendor: AiSpendVendor, now: Date): Promise<number> {
    const groups = await db.aiUsageLog.groupBy({ by: ["provider", "model"], where: { createdAt: { gte: AiSpendCap.monthStart(now) } }, _sum: { costUsd: true } });
    let owners = new Map<string, string>();
    if (typeof db.aiModel?.findMany === "function") {
      const models = await db.aiModel.findMany({ orderBy: { id: "asc" } }).catch(() => []);
      owners = new Map(models.map((m) => [m.id, m.provider]));
    }
    let total = 0;
    for (const g of groups) {
      const who = AiSpendCap.vendorOfUsage(g.provider, g.model ? (owners.get(g.model) ?? null) : null);
      if (who === vendor) total += AiSpendCap.num(g._sum.costUsd) ?? 0;
    }
    return Math.round(total * 1e6) / 1e6;
  }

  /** Admin > AI settings. A missing 0075 table reads as not ready. */
  static async view(db: AiSpendCapReadDb, now: Date = new Date()): Promise<AiSpendCapView> {
    const empty: AiSpendCapView = { ready: false, providers: [], previousPeople: [], previousDefaultUsd: null };
    let rows: AiProviderSpendRow[];
    try {
      rows = await db.aiProviderSpendCap.findMany();
    } catch (e) {
      if (AiSpendCapService.isMissingTable(e)) return empty;
      throw e;
    }
    const spent = new Map<AiSpendVendor, number>();
    for (const v of AiSpendCap.VENDORS) spent.set(v, await AiSpendCapService.spent(db, v, now).catch(() => 0));
    const providers: AiProviderSpendView[] = AiSpendCap.VENDORS.map((provider) => {
      const row = rows.find((r) => r.provider === provider);
      return { provider, label: AiSpendCap.label(provider), spentUsd: spent.get(provider) ?? 0, capUsd: row ? AiSpendCap.num(row.monthlyCapUsd) : null };
    });
    const previous = await AiSpendCapService.previous(db);
    return { ready: true, providers, ...previous };
  }

  /** The 0074 rows, split into the old default and each person's own cap. Missing table = none. */
  static async previous(db: unknown): Promise<{ previousPeople: AiPreviousPersonCap[]; previousDefaultUsd: number | null }> {
    const find = (db as { aiSpendCap?: { findMany?: () => Promise<AiSpendCapRow[]> } } | null)?.aiSpendCap?.findMany;
    if (typeof find !== "function") return { previousPeople: [], previousDefaultUsd: null };
    let rows: AiSpendCapRow[];
    try {
      rows = await find();
    } catch (e) {
      if (AiSpendCapService.isMissingTable(e)) return { previousPeople: [], previousDefaultUsd: null };
      throw e;
    }
    const fallback = rows.find((r) => r.email === AiSpendCap.DEFAULT_KEY);
    const previousPeople = rows
      .filter((r) => r.email !== AiSpendCap.DEFAULT_KEY)
      .map((r) => ({ email: r.email, capUsd: AiSpendCap.num(r.monthlyCapUsd) ?? 0 }))
      .sort((a, b) => a.email.localeCompare(b.email));
    return { previousPeople, previousDefaultUsd: fallback ? AiSpendCap.num(fallback.monthlyCapUsd) : null };
  }

  /**
   * Sets or clears one company's cap. A blank amount removes it (no cap). Admins only, never on a preview.
   * One history row per change. Saving the same amount again writes nothing.
   */
  static async setCap(args: { db: AiSpendCapWriteDb; viewer: Pick<Viewer, "email" | "isAdmin"> | null; target: unknown; amount: unknown; env?: Env; now?: () => Date }): Promise<AiSpendCapResult> {
    const env = args.env ?? process.env;
    const now = (args.now ?? (() => new Date()))();
    if (!args.viewer?.isAdmin) return { ok: false, error: AiSpendCopy.NOT_AUTHORIZED };
    if (AiKeyCipher.isPreview(env)) return { ok: false, error: AiSpendCopy.PREVIEW };
    const provider = AiSpendCap.parseVendor(args.target);
    if (!provider) return { ok: false, error: AiSpendCopy.INVALID_PROVIDER };
    const amount = AiSpendCap.parseAmount(args.amount);
    if (amount === undefined) return { ok: false, error: AiSpendCopy.INVALID_AMOUNT };
    const actor = args.viewer.email.trim().toLowerCase();
    return args.db.$transaction(async (tx) => {
      const current = await tx.aiProviderSpendCap.findUnique({ where: { provider } });
      const before = current ? AiSpendCap.num(current.monthlyCapUsd) : null;
      if (before === amount) return { ok: true } as const;
      if (amount === null) await tx.aiProviderSpendCap.deleteMany({ where: { provider } });
      else {
        await tx.aiProviderSpendCap.upsert({
          where: { provider },
          create: { provider, monthlyCapUsd: amount, updatedAt: now, updatedBy: actor },
          update: { monthlyCapUsd: amount, updatedAt: now, updatedBy: actor },
        });
      }
      await tx.aiProviderSpendCapHistory.create({ data: { id: randomUUID(), provider, oldCapUsd: before, newCapUsd: amount, note: null, changedAt: now, changedBy: actor } });
      return { ok: true } as const;
    });
  }
}
