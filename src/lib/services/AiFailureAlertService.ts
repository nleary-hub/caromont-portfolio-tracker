import { randomUUID } from "node:crypto";
import { AiCopy } from "@/lib/ai/AiCopy";
import { AiFailureAlert, AiFailureCopy, type AiFailureClass } from "@/lib/ai/AiFailureAlert";
import type { AiToggleFeature } from "@/lib/ai/AiFeatureFlags";
import type { AiCallResult, AiRuntimeConfig } from "@/lib/ai/AiProviderClient";
import { AiRegistry } from "@/lib/ai/AiRegistry";
import { AiRegistryRuntime } from "@/lib/services/AiRegistryRuntime";

type Env = Record<string, string | undefined>;
type Failure = Extract<AiCallResult, { ok: false }>;

interface EventRow {
  at: Date;
  category: string;
  primaryModel: string;
  triggerClass: string;
}

/** The 0071 tables this alert reads and writes. Both are append-only (DB triggers). */
export interface AiFailureAlertDb {
  aiFallbackEvent: {
    create(a: { data: Record<string, unknown> }): Promise<unknown>;
    findMany(a: object): Promise<EventRow[]>;
  };
  aiFallbackAck: {
    create(a: { data: Record<string, unknown> }): Promise<unknown>;
    findFirst(a: object): Promise<{ upToAt: Date } | null>;
  };
}

/** One line of the banner: a model, a category and a kind of failure, with how often and when it last happened. */
export interface AiFailureGroup {
  model: string;
  category: string;
  reason: AiFailureClass;
  count: number;
  lastAt: string;
}

/** What the Admin AI page shows. `ready` false = the tables can't be read (or the switch is off): no banner. */
export interface AiFailureAlertView {
  ready: boolean;
  total: number;
  groups: AiFailureGroup[];
}

const REASONS = Object.keys(AiFailureCopy.REASONS) as AiFailureClass[];

/**
 * The fallback choice Nick made on Nov 12: alert only. When a text AI call fails in a way an admin can act on, one row
 * goes into ai_fallback_event (outcome "no_fallback", reason "none_set"): which category, provider and model, what kind
 * of failure, and the HTTP status. Never a prompt, reply, provider message or key. Admin > AI settings shows the rows
 * since an admin last marked them as seen. No call ever switches to another model.
 *
 * Behind AI_REGISTRY_RUNTIME, like the rest of Phase 2: with the switch off nothing is read or written here. Recording
 * never throws and never changes what the person sees beyond the message for failures that "try again" won't fix.
 */
export class AiFailureAlertService {
  /** How far back the banner looks, at most. */
  static readonly DAYS = 30;
  static readonly MAX_ROWS = 500;

  static isOn(env: Env = process.env): boolean {
    return AiRegistryRuntime.isOn(env);
  }

  private static tables(db: unknown): AiFailureAlertDb | null {
    const d = db as { aiFallbackEvent?: { create?: unknown; findMany?: unknown }; aiFallbackAck?: { create?: unknown; findFirst?: unknown } } | null;
    const ok = typeof d?.aiFallbackEvent?.create === "function" && typeof d?.aiFallbackEvent?.findMany === "function" && typeof d?.aiFallbackAck?.create === "function" && typeof d?.aiFallbackAck?.findFirst === "function";
    return ok ? (db as AiFailureAlertDb) : null;
  }

  /**
   * Records one failed text AI call, when the switch is on and the failure is one an admin can act on. Returns the
   * failure's class (null = not recorded and not one this alert knows), so the caller can pick the message.
   */
  static async record(args: { db: unknown; feature: AiToggleFeature; config: Pick<AiRuntimeConfig, "provider" | "model">; result: Failure; env?: Env; now?: Date }): Promise<AiFailureClass | null> {
    const env = args.env ?? process.env;
    if (!AiFailureAlertService.isOn(env)) return null;
    const cls = AiFailureAlert.classify(args.result);
    if (!cls) return null;
    const category = AiRegistry.categoryOf(args.feature);
    const t = AiFailureAlertService.tables(args.db);
    if (!category || !t || !AiFailureAlert.MODEL_SHAPE.test(args.config.model)) return cls;
    try {
      await t.aiFallbackEvent.create({
        data: {
          id: randomUUID(),
          at: args.now ?? new Date(),
          category,
          primaryProvider: AiFailureAlert.providerOf(args.config.provider),
          primaryModel: args.config.model,
          fallbackProvider: null,
          fallbackModel: null,
          triggerClass: cls,
          faultReason: null,
          noFallbackReason: "none_set",
          httpStatus: AiFailureAlert.statusOf(args.result),
          outcome: "no_fallback",
        },
      });
    } catch (e) {
      // The alert never stops the reply the person gets. Error name only (no content).
      console.error("AI failure alert: could not record the failure", (e as Error)?.name);
    }
    return cls;
  }

  /** The person's message: today's, except for failures that trying again won't fix (recorded with the switch on). */
  static message(cls: AiFailureClass | null, today: string, notUsable: string): string {
    return AiFailureAlert.notRetryable(cls) ? notUsable : today;
  }

  /** The failures since an admin last marked them as seen (at most the last DAYS days), grouped for the banner. */
  static async view(db: unknown, when: (d: Date) => string, env: Env = process.env, now: Date = new Date()): Promise<AiFailureAlertView> {
    const none: AiFailureAlertView = { ready: false, total: 0, groups: [] };
    if (!AiFailureAlertService.isOn(env)) return none;
    const t = AiFailureAlertService.tables(db);
    if (!t) return none;
    try {
      const ack = await t.aiFallbackAck.findFirst({ orderBy: { upToAt: "desc" }, select: { upToAt: true } });
      const floor = new Date(now.getTime() - AiFailureAlertService.DAYS * 86_400_000);
      const since = ack && ack.upToAt > floor ? ack.upToAt : floor;
      const rows = await t.aiFallbackEvent.findMany({
        where: { at: { gt: since }, outcome: "no_fallback", noFallbackReason: "none_set" },
        select: { at: true, category: true, primaryModel: true, triggerClass: true },
        orderBy: { at: "desc" },
        take: AiFailureAlertService.MAX_ROWS,
      });
      return { ready: true, total: rows.length, groups: AiFailureAlertService.group(rows, when) };
    } catch (e) {
      console.error("AI failure alert: could not read failures", (e as Error)?.name);
      return none;
    }
  }

  /** Newest first; one group per model, category and kind of failure. */
  static group(rows: readonly EventRow[], when: (d: Date) => string): AiFailureGroup[] {
    const out = new Map<string, AiFailureGroup & { last: Date }>();
    for (const r of rows) {
      if (!(REASONS as string[]).includes(r.triggerClass)) continue;
      const key = `${r.primaryModel}\u0000${r.category}\u0000${r.triggerClass}`;
      const g = out.get(key);
      if (g) {
        g.count++;
        if (r.at > g.last) g.last = r.at;
      } else out.set(key, { model: r.primaryModel, category: AiCopy.categoryLabel(r.category), reason: r.triggerClass as AiFailureClass, count: 1, lastAt: "", last: r.at });
    }
    return [...out.values()].sort((a, b) => b.last.getTime() - a.last.getTime()).map(({ last, ...g }) => ({ ...g, lastAt: when(last) }));
  }

  /** Marks every failure up to now as seen (one append-only ack row). Admin only; the action checks that. */
  static async acknowledge(db: unknown, by: string, env: Env = process.env, now: Date = new Date()): Promise<{ ok: true } | { ok: false; error: string }> {
    const t = AiFailureAlertService.tables(db);
    if (!AiFailureAlertService.isOn(env) || !t) return { ok: false, error: AiFailureCopy.ACK_FAILED };
    if (env.VERCEL_ENV === "preview") return { ok: false, error: AiFailureCopy.PREVIEW };
    const email = by.trim().slice(0, 254);
    if (!email) return { ok: false, error: AiFailureCopy.ACK_FAILED };
    await t.aiFallbackAck.create({ data: { id: randomUUID(), at: now, by: email, upToAt: now } });
    return { ok: true };
  }
}
