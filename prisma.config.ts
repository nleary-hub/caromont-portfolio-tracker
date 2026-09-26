import "dotenv/config";
import { defineConfig } from "prisma/config";

// Prisma CLI connection (migrate deploy/dev, db pull, studio). Prefer the DIRECT (unpooled)
// connection: migrations over Neon's PgBouncer pooler can fail (advisory locks, prepared
// statements). Prisma 7 has no `directUrl`; per the Prisma 7 Neon guide the CLI URL lives here.
// The runtime app does NOT read this file: Prisma Client uses the pooled DATABASE_URL via the
// driver adapter in src/lib/db/Db.ts.
const cliDatabaseUrl = process.env["DATABASE_URL_UNPOOLED"] || process.env["DATABASE_URL"];

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // Not required for `prisma generate` / `migrate diff`; required for migrate deploy/dev.
    url: cliDatabaseUrl,
  },
});
