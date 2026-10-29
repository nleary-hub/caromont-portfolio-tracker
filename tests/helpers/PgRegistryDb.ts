import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import type { AiRegistryDb } from "@/lib/services/AiRegistryService";

export const MIGRATIONS_DIR = path.resolve(__dirname, "../../prisma/migrations");

export function migrationFolders(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
}

/** A throwaway in-memory PGlite database with the migrations up to and including `through` applied (default: all). Nothing leaves the process. */
export async function migratedPglite(through?: string): Promise<PGlite> {
  const pg = await PGlite.create();
  for (const f of migrationFolders()) {
    if (through && f > through) break;
    await pg.exec(readFileSync(path.join(MIGRATIONS_DIR, f, "migration.sql"), "utf8"));
  }
  return pg;
}

export interface RegistryHarness {
  pg: PGlite;
  prisma: PrismaClient;
  db: AiRegistryDb;
  stop(): Promise<void>;
}

/** A real Prisma client (driver adapter) over the PGlite socket, 127.0.0.1 only, random port, fictional password. */
export async function registryHarness(): Promise<RegistryHarness> {
  const pg = await migratedPglite();
  const port = 20000 + Math.floor(Math.random() * 20000);
  const server = new PGLiteSocketServer({ db: pg, port, host: "127.0.0.1", maxConnections: 4 });
  await server.start();
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`, max: 1 }) });
  return {
    pg,
    prisma,
    db: prisma as unknown as AiRegistryDb,
    stop: async () => {
      await prisma.$disconnect();
      await server.stop();
      await pg.close();
    },
  };
}

/** Run SQL and say whether Postgres refused it: the error text (first line) or null. */
export async function refusal(pg: PGlite, sql: string, params: unknown[] = []): Promise<string | null> {
  try {
    await pg.query(sql, params);
    return null;
  } catch (e) {
    return String((e as Error).message).split("\n")[0];
  }
}

let baseDump: Promise<Blob | File> | null = null;

/** A fresh database holding migrations 0001..0070 only (what Production has before 0071). Cloned from one dump, so it is fast. */
export async function db0070(): Promise<PGlite> {
  baseDump ??= migratedPglite("0070_role_description").then((pg) => pg.dumpDataDir("none"));
  return PGlite.create({ loadDataDir: await baseDump });
}

/** The 0071 file as text. */
export function migration0071(): string {
  return readFileSync(path.join(MIGRATIONS_DIR, "0071_ai_registry_and_fallback", "migration.sql"), "utf8");
}

/** Insert an ai_models row (fictional). */
export async function addAiModel(pg: PGlite, id: string, opts: { provider?: string; enabled?: boolean; kind?: string | null; priceUnit?: string | null; inputPrice?: number | null; outputPrice?: number | null } = {}): Promise<void> {
  await pg.query(
    `INSERT INTO ai_models (id, provider, enabled, kind, "priceUnit", "inputPrice", "outputPrice", "addedBy", "updatedBy") VALUES ($1, $2, $3, $4, $5, $6, $7, 'fiction@example.test', 'fiction@example.test')`,
    [id, opts.provider ?? "openai", opts.enabled ?? true, opts.kind ?? null, opts.priceUnit ?? null, opts.inputPrice ?? null, opts.outputPrice ?? null],
  );
}
