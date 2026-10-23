// Local end-to-end server for tests/e2e (playwright.e2e.config.ts): an in-memory Postgres (PGlite over a socket) with
// every migration applied, and `next dev` on 127.0.0.1:$E2E_PORT (default 4183, apart from the browser fixture on 4174) with the local-only dev login. Fictional emails, random
// throwaway secrets generated here, VERCEL_ENV=preview (guard (a)). It never reads .env files or production settings.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
const port = process.env.E2E_PORT || "4183";

const root = process.cwd();
const dir = path.join(root, "prisma/migrations");
const db = await PGlite.create();
for (const f of readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) await db.exec(readFileSync(path.join(dir, f, "migration.sql"), "utf8"));
const server = new PGLiteSocketServer({ db, port: 5439, host: "127.0.0.1", maxConnections: 20 });
await server.start();
console.log("e2e database ready on 127.0.0.1:5439");

const env = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  NODE_ENV: "development",
  NEXT_TELEMETRY_DISABLED: "1",
  DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:5439/postgres",
  AUTH_SECRET: randomBytes(32).toString("base64"),
  AUTH_DEV_LOGIN: "true",
  AUTH_TRUST_HOST: "true",
  AUTH_URL: `http://127.0.0.1:${port}`,
  ALLOWED_EMAILS: "jordan.pike@example.org riley.moss@example.org casey.lund@example.org taylor.reed@example.org morgan.hale@example.org quinn.vale@example.org",
  ADMIN_EMAILS: "jordan.pike@example.org casey.lund@example.org",
  // The fictional Owner (OwnerPolicy): only Jordan has AI; Casey is an admin without it, Riley a viewer, Morgan an Editor and Quinn a Viewer (set by their specs).
  OWNER_EMAIL: "jordan.pike@example.org",
  AI_SETTINGS_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
  VERCEL_ENV: "preview",
};
const next = spawn(path.join(root, "node_modules/.bin/next"), ["dev", "-H", "127.0.0.1", "-p", port], { env, stdio: "inherit" });
const stop = async () => {
  next.kill("SIGTERM");
  await server.stop();
  await db.close();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
next.on("exit", (code) => process.exit(code ?? 0));
