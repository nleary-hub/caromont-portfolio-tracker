/**
 * Custom role descriptions (migration 0070). The column is kept out of the Prisma Role model on purpose, so no Prisma
 * query (default selects, create or update RETURNING) ever touches it. This class reads and writes it with raw SQL,
 * only after checking once that the column exists. Before 0070 is applied, reads return nothing and writes are
 * skipped. A missing column is re-checked after a minute, so applying 0070 needs no restart.
 */
export interface RawDb {
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

const RECHECK_MS = 60_000;

export class RoleDescriptions {
  private static present: boolean | null = null;
  private static checkedAt = 0;

  /** Test hook: forget the cached column check. */
  static reset(): void {
    RoleDescriptions.present = null;
    RoleDescriptions.checkedAt = 0;
  }

  static async enabled(db: RawDb, now: number = Date.now()): Promise<boolean> {
    if (RoleDescriptions.present === true) return true;
    if (RoleDescriptions.present === false && now - RoleDescriptions.checkedAt < RECHECK_MS) return false;
    let found = false;
    try {
      const rows = await db.$queryRawUnsafe<unknown[]>(
        `SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'role' AND column_name = 'description'`,
      );
      found = Array.isArray(rows) && rows.length > 0;
    } catch {
      found = false;
    }
    RoleDescriptions.present = found;
    RoleDescriptions.checkedAt = now;
    return found;
  }

  /** Every stored description by role id; empty when the column is absent. */
  static async all(db: RawDb): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!(await RoleDescriptions.enabled(db))) return out;
    const rows = await db.$queryRawUnsafe<{ id: string; description: string | null }[]>(`SELECT "id", "description" FROM "role" WHERE "description" IS NOT NULL`);
    for (const r of rows) if (r.description) out.set(r.id, r.description);
    return out;
  }

  static async get(db: RawDb, roleId: string): Promise<string | null> {
    if (!(await RoleDescriptions.enabled(db))) return null;
    const rows = await db.$queryRawUnsafe<{ description: string | null }[]>(`SELECT "description" FROM "role" WHERE "id" = $1`, roleId);
    return rows[0]?.description ?? null;
  }

  /** Saves a description; returns false (and writes nothing) when the column is absent. */
  static async set(db: RawDb, roleId: string, description: string | null): Promise<boolean> {
    if (!(await RoleDescriptions.enabled(db))) return false;
    await db.$executeRawUnsafe(`UPDATE "role" SET "description" = $1 WHERE "id" = $2`, description, roleId);
    return true;
  }
}
