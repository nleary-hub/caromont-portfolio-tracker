import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // Not required for `prisma generate` / `migrate diff`; required for migrate deploy/dev.
    url: process.env["DATABASE_URL"],
  },
});
