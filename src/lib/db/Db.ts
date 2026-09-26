import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";

const globalForPrisma = globalThis as unknown as { __portfolioPrisma?: PrismaClient };

/** Lazily-constructed Prisma client (driver adapter: node-postgres; works with Neon/Vercel Postgres URLs). */
export class Db {
  static get client(): PrismaClient {
    if (!globalForPrisma.__portfolioPrisma) {
      const connectionString = process.env.DATABASE_URL;
      if (!connectionString) throw new Error("DATABASE_URL is not set");
      globalForPrisma.__portfolioPrisma = new PrismaClient({
        adapter: new PrismaPg({ connectionString }),
      });
    }
    return globalForPrisma.__portfolioPrisma;
  }

  static isConfigured(): boolean {
    return Boolean(process.env.DATABASE_URL);
  }
}
