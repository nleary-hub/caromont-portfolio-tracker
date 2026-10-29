import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import type { AiProviderKeyDb, AiProviderKeyRow, AiProviderKeyTx } from "@/lib/services/AiProviderKeyService";
import type { AiSettingsHistoryRow, AiSettingsRow } from "@/lib/services/AiSettingsService";

const DIR = path.resolve(__dirname, "../../prisma/migrations");
const KEY_COLS = ["provider", "ciphertext", "last4", "label", "baseUrl", "setAt", "setBy", "lastTestedAt", "lastTestStatus", "updatedAt", "updatedBy"] as const;

type Q = PGlite | Transaction;

/**
 * The slice of Prisma that AiProviderKeyService and AiSettingsService use, over a real Postgres (PGlite) with every
 * migration applied, so the unique key, the CHECK constraints, the no-delete trigger and ON CONFLICT DO NOTHING are the
 * real ones. createMany with skipDuplicates is the SQL Prisma sends: INSERT ... ON CONFLICT DO NOTHING.
 */
export class PgProviderKeyDb implements AiProviderKeyDb {
  /** Calls to aiProviderKey.createMany (to show that racing reads really both tried to insert). */
  static inserts = 0;
  /** Calls to aiSettings.upsert, and a switch that makes the next ones throw (item 19 rollback tests). */
  static settingsUpserts = 0;
  static failSettingsUpsert = false;

  constructor(private readonly q: Q, private readonly root: PGlite) {}

  static async create(): Promise<{ pg: PGlite; db: PgProviderKeyDb }> {
    const pg = await PGlite.create();
    const folders = readdirSync(DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    for (const f of folders) await pg.exec(readFileSync(path.join(DIR, f, "migration.sql"), "utf8"));
    return { pg, db: new PgProviderKeyDb(pg, pg) };
  }

  aiProviderKey: AiProviderKeyTx["aiProviderKey"] = {
    findMany: async () => (await this.q.query<AiProviderKeyRow>(`SELECT * FROM "ai_provider_keys" ORDER BY "provider"`)).rows,
    findUnique: async ({ where }) => (await this.q.query<AiProviderKeyRow>(`SELECT * FROM "ai_provider_keys" WHERE "provider" = $1`, [where.provider])).rows[0] ?? null,
    createMany: async ({ data }) => {
      PgProviderKeyDb.inserts += 1;
      let count = 0;
      for (const row of data) {
        const cols = KEY_COLS.map((c) => `"${c}"`).join(", ");
        const params = KEY_COLS.map((c) => row[c]);
        const r = await this.q.query(`INSERT INTO "ai_provider_keys" (${cols}) VALUES (${KEY_COLS.map((_, i) => `$${i + 1}`).join(", ")}) ON CONFLICT DO NOTHING`, params);
        count += r.affectedRows ?? 0;
      }
      return { count };
    },
    update: async ({ where, data }) => {
      const keys = Object.keys(data) as (keyof AiProviderKeyRow)[];
      const set = keys.map((k, i) => `"${k}" = $${i + 2}`).join(", ");
      const r = await this.q.query<AiProviderKeyRow>(`UPDATE "ai_provider_keys" SET ${set} WHERE "provider" = $1 RETURNING *`, [where.provider, ...keys.map((k) => data[k])]);
      if (!r.rows[0]) throw new Error("Record to update not found.");
      return r.rows[0];
    },
  };

  aiSettings: AiProviderKeyTx["aiSettings"] & {
    upsert(args: { where: { id: string }; create: AiSettingsRow; update: Partial<AiSettingsRow> }): Promise<AiSettingsRow>;
  } = {
    findUnique: async ({ where }) => (await this.q.query<AiSettingsRow>(`SELECT * FROM "ai_settings" WHERE "id" = $1`, [where.id])).rows[0] ?? null,
    upsert: async ({ create, update }) => {
      PgProviderKeyDb.settingsUpserts += 1;
      if (PgProviderKeyDb.failSettingsUpsert) throw new Error("injected ai_settings write failure");
      const cols = Object.keys(create) as (keyof AiSettingsRow)[];
      const upd = Object.keys(update) as (keyof AiSettingsRow)[];
      const onConflict = upd.length ? ` ON CONFLICT ("id") DO UPDATE SET ${upd.map((c, i) => `"${c}" = $${cols.length + i + 1}`).join(", ")}` : "";
      const r = await this.q.query<AiSettingsRow>(
        `INSERT INTO "ai_settings" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})${onConflict} RETURNING *`,
        [...cols.map((c) => create[c]), ...upd.map((c) => update[c])],
      );
      return r.rows[0] ?? create;
    },
  };

  aiSettingsHistory: AiProviderKeyTx["aiSettingsHistory"] & { findMany(): Promise<AiSettingsHistoryRow[]> } = {
    createMany: async ({ data }) => {
      for (const h of data) await this.q.query(`INSERT INTO "ai_settings_history" ("id", "field", "action", "oldValue", "newValue", "changedAt", "changedBy") VALUES ($1, $2, $3, $4, $5, $6, $7)`, [h.id, h.field, h.action, h.oldValue, h.newValue, h.changedAt, h.changedBy]);
      return { count: data.length };
    },
    findMany: async () => (await this.q.query<AiSettingsHistoryRow>(`SELECT * FROM "ai_settings_history" ORDER BY "changedAt", "action"`)).rows,
  };

  async $transaction<T>(fn: (tx: AiProviderKeyTx) => Promise<T>): Promise<T> {
    return this.root.transaction((tx) => fn(new PgProviderKeyDb(tx, this.root)));
  }
}
