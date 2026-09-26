import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { AdminPolicy, type Viewer } from "@/lib/auth/AdminPolicy";
import { Db } from "@/lib/db/Db";
import { ServiceLine, type ServiceLineValue } from "@/lib/domain/ServiceLine";

type Reader = Pick<Prisma.TransactionClient, "serviceLineSettings">;
type HistoryReader = Pick<Prisma.TransactionClient, "serviceLineSettingsHistory">;

export interface ServiceLineChange {
  oldValue: ServiceLineValue;
  newValue: ServiceLineValue;
  changedAt: Date;
  changedBy: string;
}

/**
 * The only read/write path for service_line_settings. Reads fall back to the seed values when the row is
 * missing. Writes are admin-only and append an audit row (old, new, who, when) in the same transaction.
 */
export class ServiceLineService {
  static readonly ID = "service_line";

  static async get(db: Reader = Db.client): Promise<ServiceLineValue> {
    const row = await db.serviceLineSettings.findUnique({ where: { id: ServiceLineService.ID } });
    return row ? ServiceLine.normalize(row) : ServiceLine.defaults();
  }

  /** For pages that must render without a database (DATABASE_URL unset or down): seed values then. */
  static async getOrDefault(db?: Reader): Promise<ServiceLineValue> {
    if (!db && !Db.isConfigured()) return ServiceLine.defaults();
    try {
      return await ServiceLineService.get(db ?? Db.client);
    } catch (e) {
      console.error("Could not read service line settings; using defaults", e);
      return ServiceLine.defaults();
    }
  }

  static async update(input: { name?: unknown; shortName?: unknown }, admin: Viewer, db: PrismaClient = Db.client): Promise<ServiceLineValue> {
    AdminPolicy.assertAdmin(admin);
    const after = ServiceLine.parse(input);
    return db.$transaction(async (tx) => {
      const before = await ServiceLineService.get(tx);
      if (ServiceLine.equals(before, after)) return before;
      await tx.serviceLineSettings.upsert({
        where: { id: ServiceLineService.ID },
        create: { id: ServiceLineService.ID, ...after, updatedBy: admin.email },
        update: { ...after, updatedBy: admin.email },
      });
      await tx.serviceLineSettingsHistory.create({
        data: {
          oldValue: before as unknown as Prisma.InputJsonValue,
          newValue: after as unknown as Prisma.InputJsonValue,
          changedBy: admin.email,
        },
      });
      return after;
    });
  }

  /** Recent changes, newest first (admin only). */
  static async history(admin: Viewer, limit = 20, db: HistoryReader = Db.client): Promise<ServiceLineChange[]> {
    AdminPolicy.assertAdmin(admin);
    const rows = await db.serviceLineSettingsHistory.findMany({ orderBy: { changedAt: "desc" }, take: limit });
    return rows.map((r) => ({
      oldValue: ServiceLine.normalize(r.oldValue),
      newValue: ServiceLine.normalize(r.newValue),
      changedAt: r.changedAt,
      changedBy: r.changedBy,
    }));
  }
}
