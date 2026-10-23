import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@/generated/prisma/client";
import { RoleDescriptions } from "@/lib/permissions/RoleDescriptions";
import { RoleService, type RoleTxDb } from "@/lib/services/RoleService";

// Migration 0070 is applied by hand after deploy. The Roles editor must list, create, rename, duplicate, edit and
// delete roles on a real Prisma client against a database WITHOUT "role"."description", and save descriptions once
// 0070 is applied. Fictional people only.
const ENV = { OWNER_EMAIL: "jordan.pike@example.org", ADMIN_EMAILS: "jordan.pike@example.org" };
const OWNER = { email: "jordan.pike@example.org", isAdmin: true };
const DIR = path.resolve(__dirname, "../prisma/migrations");
const ALL = readdirSync(DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();

let server: PGLiteSocketServer | null = null;
let prisma: PrismaClient | null = null;

async function start(withDescription: boolean): Promise<{ db: RoleTxDb; pg: PGlite }> {
  const pg = await PGlite.create();
  for (const f of ALL.filter((f) => withDescription || f !== "0070_role_description")) await pg.exec(readFileSync(path.join(DIR, f, "migration.sql"), "utf8"));
  const port = 20000 + Math.floor(Math.random() * 20000);
  server = new PGLiteSocketServer({ db: pg, port, host: "127.0.0.1", maxConnections: 4 });
  await server.start();
  prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`, max: 1 }) });
  await pg.exec(`INSERT INTO app_user (email, name, "roleId") VALUES ('noor.bellamy@example.org', 'Noor Bellamy', 'editor')`);
  return { db: prisma as unknown as RoleTxDb, pg };
}

beforeEach(() => RoleDescriptions.reset());
afterEach(async () => {
  await prisma?.$disconnect();
  await server?.stop();
  prisma = null;
  server = null;
});

describe("Roles editor before migration 0070 (no role.description column)", () => {
  it("lists, creates, renames, duplicates, edits keys and deletes roles; descriptions are skipped", async () => {
    const { db, pg } = await start(false);
    const cols = await pg.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'role'`);
    expect(cols.rows.map((r) => r.column_name)).not.toContain("description");

    const before = await RoleService.load(OWNER, db, ENV);
    expect(before.descriptions).toBe(false);
    expect(before.roles.map((r) => r.id)).toEqual(expect.arrayContaining(["admin", "director", "manager", "editor", "viewer"]));
    expect(before.roles.find((r) => r.id === "editor")!.description).toBe("Edits projects and updates");

    const created = await RoleService.create(OWNER, "Report reviewer", "Reads reports only", db, ENV);
    expect(created).toMatchObject({ ok: true });
    const id = (created as { roleId: string }).roleId;
    expect(await RoleService.saveKeys(OWNER, id, ["report.view"], db, ENV)).toMatchObject({ ok: true });
    expect(await RoleService.rename(OWNER, id, "Report readers", "Ignored without 0070", db, ENV)).toMatchObject({ ok: true });
    expect(await RoleService.duplicate(OWNER, id, db, ENV)).toMatchObject({ ok: true });

    const mid = await RoleService.load(OWNER, db, ENV);
    const row = mid.roles.find((r) => r.id === id)!;
    expect(row).toMatchObject({ name: "Report readers", description: "", keys: ["report.view"] });
    expect(mid.roles.some((r) => r.name === "Report readers copy")).toBe(true);

    await pg.exec(`UPDATE app_user SET "roleId" = '${id}' WHERE email = 'noor.bellamy@example.org'`);
    expect(await RoleService.remove(OWNER, id, "viewer", db, ENV)).toMatchObject({ ok: true, message: "Role deleted." });
    const after = await RoleService.load(OWNER, db, ENV);
    expect(after.roles.some((r) => r.id === id)).toBe(false);
    expect(after.roles.find((r) => r.id === "viewer")!.users.map((u) => u.name)).toContain("Noor Bellamy");
    const history = await pg.query<{ action: string }>(`SELECT action FROM role_history WHERE "roleId" = $1`, [id]);
    expect(history.rows.map((r) => r.action)).toEqual(expect.arrayContaining(["create", "keys", "rename", "delete"]));
  }, 60_000);
});

describe("Roles editor after migration 0070", () => {
  it("saves and shows custom role descriptions", async () => {
    const { db } = await start(true);
    const created = await RoleService.create(OWNER, "Report reviewer", "Reads reports only", db, ENV);
    const id = (created as { roleId: string }).roleId;
    let data = await RoleService.load(OWNER, db, ENV);
    expect(data.descriptions).toBe(true);
    expect(data.roles.find((r) => r.id === id)!.description).toBe("Reads reports only");
    await RoleService.rename(OWNER, id, "Report reviewer", "Reads and checks reports", db, ENV);
    data = await RoleService.load(OWNER, db, ENV);
    expect(data.roles.find((r) => r.id === id)!.description).toBe("Reads and checks reports");
  }, 60_000);
});
