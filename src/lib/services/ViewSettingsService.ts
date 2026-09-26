import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import type { ViewContext } from "@/generated/prisma/enums";
import { Db } from "@/lib/db/Db";
import { ViewSettings, type ViewSettingsByContext, type ViewSettingsValue } from "@/lib/domain/ViewSettings";
import type { Actor } from "@/lib/services/ProjectService";

type Reader = Pick<Prisma.TransactionClient, "viewSettings">;

/**
 * The only read/write path for view_settings. Settings are global (not per user) in v1.
 * Every effective change appends a view_settings_history row in the same transaction.
 */
export class ViewSettingsService {
  /** Current settings for a context; defaults when the row is missing. */
  static async get(context: ViewContext, db: Reader = Db.client): Promise<ViewSettingsValue> {
    const row = await db.viewSettings.findUnique({ where: { context } });
    return row ? ViewSettings.normalize(context, row) : ViewSettings.defaults(context);
  }

  static async getAll(db: Reader = Db.client): Promise<ViewSettingsByContext> {
    const [dashboard, report] = await Promise.all([
      ViewSettingsService.get("dashboard", db),
      ViewSettingsService.get("report", db),
    ]);
    return { dashboard, report };
  }

  /**
   * Replace the settings for a context. Input is normalized first. No-op (no writes) when
   * nothing changes; otherwise upserts the row and appends a history row (who, when, old, new).
   */
  static async update(
    context: ViewContext,
    next: unknown,
    actor: Actor,
    db: PrismaClient = Db.client,
  ): Promise<ViewSettingsValue> {
    if (!ViewSettings.isContext(context)) throw new Error(`Unknown view context: ${String(context)}`);
    const value = ViewSettings.normalize(context, next);
    return db.$transaction(async (tx) => {
      const old = await ViewSettingsService.get(context, tx);
      if (ViewSettings.equals(old, value)) return old;
      const now = new Date();
      await tx.viewSettings.upsert({
        where: { context },
        create: { context, ...value, updatedBy: actor.changedBy },
        update: { ...value, updatedBy: actor.changedBy },
      });
      await tx.viewSettingsHistory.create({
        data: {
          context,
          oldValue: old as unknown as Prisma.InputJsonValue,
          newValue: value as unknown as Prisma.InputJsonValue,
          changedAt: now,
          changedBy: actor.changedBy,
        },
      });
      return value;
    });
  }

  static async reset(context: ViewContext, actor: Actor, db: PrismaClient = Db.client): Promise<ViewSettingsValue> {
    return ViewSettingsService.update(context, ViewSettings.defaults(context), actor, db);
  }
}
