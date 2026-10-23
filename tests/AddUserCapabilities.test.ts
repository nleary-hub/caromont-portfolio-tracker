import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@/generated/prisma/client";
import { ROLE_DEFAULTS } from "@/lib/permissions";

// Security fix (PR #96 review): Add user must check every capability it uses, in the service, before any write.
// Real Prisma client on PGlite with every migration; the Server Action path runs with a mocked session only.
// Fictional people and lines only.
const state = vi.hoisted(() => ({ client: null as unknown, viewer: null as unknown }));
vi.mock("@/lib/db/Db", () => ({ Db: { get client() { return state.client; } } }));
vi.mock("@/lib/auth/CurrentViewer", () => ({ CurrentViewer: { get: async () => state.viewer } }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { addUserAccount } from "@/app/actions/accounts";
import { LineAccessCopy } from "@/lib/access/LineAccessCopy";
import { PasswordCopy } from "@/lib/auth/PasswordCopy";
import { UserAccountService } from "@/lib/services/UserAccountService";

const ENV = { OWNER_EMAIL: "jordan.pike@example.org", ADMIN_EMAILS: "casey.lund@example.org", ALLOWED_EMAILS: "" };
const LINE_A = "00000000-0000-4000-8000-0000000000a1";
const LINE_B = "00000000-0000-4000-8000-0000000000b2";
const keysOf = (id: string) => [...ROLE_DEFAULTS.find((r) => r.id === id)!.keys];
const OWNER = { email: "jordan.pike@example.org", isAdmin: true, name: "Jordan Pike" };
const ADMIN = { email: "casey.lund@example.org", isAdmin: true, roleId: "admin", rank: 50, keys: keysOf("admin"), name: "Casey Lund" };
const DIRECTOR = { email: "dana.orr@example.org", isAdmin: false, roleId: "director", rank: 40, keys: keysOf("director"), name: "Dana Orr" };
const ADD_ONLY = { ...DIRECTOR, keys: ["people.view", "people.user.add"] };

let pg: PGlite;
let server: PGLiteSocketServer;
let prisma: PrismaClient;
const db = () => prisma as unknown as Parameters<typeof UserAccountService.addUser>[2];

async function counts(email: string) {
  const q = async (sql: string) => Number((await pg.query<{ n: number }>(sql, [email])).rows[0].n);
  return {
    user: await q(`SELECT count(*)::int AS n FROM app_user WHERE email = $1`),
    grants: await q(`SELECT count(*)::int AS n FROM service_line_access WHERE email = $1`),
    credentials: await q(`SELECT count(*)::int AS n FROM password_credential WHERE email = $1`),
  };
}
const NOTHING = { user: 0, grants: 0, credentials: 0 };

beforeAll(async () => {
  pg = await PGlite.create();
  const dir = path.resolve(__dirname, "../prisma/migrations");
  for (const f of readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) await pg.exec(readFileSync(path.join(dir, f, "migration.sql"), "utf8"));
  for (const [id, name, short] of [[LINE_A, "Alder Line", "ALD"], [LINE_B, "Birch Line", "BIR"]]) {
    await pg.query(`INSERT INTO service_line (id, name, "shortName", "updatedAt", "updatedBy") VALUES ($1, $2, $3, now(), 'seed@example.org')`, [id, name, short]);
  }
  await pg.exec(`INSERT INTO app_user (email, name, "roleId") VALUES ('dana.orr@example.org', 'Dana Orr', 'director')`);
  await pg.query(`INSERT INTO service_line_access (email, "serviceLineId", "grantedBy") VALUES ('dana.orr@example.org', $1, 'seed@example.org')`, [LINE_A]);
  const port = 20000 + Math.floor(Math.random() * 20000);
  server = new PGLiteSocketServer({ db: pg, port, host: "127.0.0.1", maxConnections: 4 });
  await server.start();
  prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`, max: 1 }) });
  state.client = prisma;
}, 60_000);
afterAll(async () => {
  await prisma?.$disconnect();
  await server?.stop();
});
beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
});

describe("UserAccountService.addUser checks every capability before writing", () => {
  it("refuses line access without people.access.grant and writes nothing", async () => {
    const r = await UserAccountService.addUser(ADD_ONLY, { email: "ava.lin@example.org", lineIds: [LINE_A] }, db(), ENV);
    expect(r).toEqual({ ok: false, message: LineAccessCopy.SAVE_ERROR });
    expect(await counts("ava.lin@example.org")).toEqual(NOTHING);
  });
  it("refuses a temporary password without people.user.password and writes nothing", async () => {
    const r = await UserAccountService.addUser(ADD_ONLY, { email: "bo.kerr@example.org", createPassword: true }, db(), ENV);
    expect(r).toEqual({ ok: false, message: PasswordCopy.SAVE_ERROR });
    expect(await counts("bo.kerr@example.org")).toEqual(NOTHING);
  });
  it("refuses a line the Director does not hold, even mixed with one they do, and writes nothing", async () => {
    const r = await UserAccountService.addUser(DIRECTOR, { email: "cy.dunn@example.org", lineIds: [LINE_A, LINE_B], createPassword: true }, db(), ENV);
    expect(r).toEqual({ ok: false, message: LineAccessCopy.SAVE_ERROR });
    expect(await counts("cy.dunn@example.org")).toEqual(NOTHING);
  });
  it("refuses an account that would not rank below the actor (the Owner's address) and writes nothing", async () => {
    const r = await UserAccountService.addUser(ADMIN, { email: "Jordan.Pike@example.org" }, db(), ENV);
    expect(r.ok).toBe(false);
    expect(await counts("jordan.pike@example.org")).toEqual(NOTHING);
  });
  it("still lets an account-only add through with just people.user.add", async () => {
    const r = await UserAccountService.addUser(ADD_ONLY, { email: "di.vance@example.org" }, db(), ENV);
    expect(r).toMatchObject({ ok: true, temporaryPassword: undefined });
    expect(await counts("di.vance@example.org")).toEqual({ user: 1, grants: 0, credentials: 0 });
  });
  it("lets a Director give their own line with a password", async () => {
    const r = await UserAccountService.addUser(DIRECTOR, { email: "em.roy@example.org", lineIds: [LINE_A], createPassword: true }, db(), ENV);
    expect(r).toMatchObject({ ok: true });
    expect(await counts("em.roy@example.org")).toEqual({ user: 1, grants: 1, credentials: 1 });
  });
  it("lets the Owner and an admin give any line", async () => {
    expect(await UserAccountService.addUser(OWNER, { email: "fi.moss@example.org", lineIds: [LINE_A, LINE_B], createPassword: true }, db(), ENV)).toMatchObject({ ok: true });
    expect(await counts("fi.moss@example.org")).toEqual({ user: 1, grants: 2, credentials: 1 });
    expect(await UserAccountService.addUser(ADMIN, { email: "gus.hale@example.org", lineIds: [LINE_B] }, db(), ENV)).toMatchObject({ ok: true });
    expect(await counts("gus.hale@example.org")).toEqual({ user: 1, grants: 1, credentials: 0 });
  });
});

describe("addUserAccount Server Action (direct POST path)", () => {
  it("refuses a crafted request for an out-of-scope line and writes nothing", async () => {
    state.viewer = DIRECTOR;
    const r = await addUserAccount({ email: "hal.ives@example.org", name: "Hal Ives", lineIds: [LINE_B], createPassword: true });
    expect(r.ok).toBe(false);
    expect(await counts("hal.ives@example.org")).toEqual(NOTHING);
  });
  it("refuses lines and a password for an add-only role and writes nothing", async () => {
    state.viewer = ADD_ONLY;
    expect((await addUserAccount({ email: "ida.wren@example.org", name: "", lineIds: [LINE_A], createPassword: false })).ok).toBe(false);
    expect((await addUserAccount({ email: "ida.wren@example.org", name: "", lineIds: [], createPassword: true })).ok).toBe(false);
    expect(await counts("ida.wren@example.org")).toEqual(NOTHING);
  });
  it("still works for an allowed request", async () => {
    state.viewer = DIRECTOR;
    expect(await addUserAccount({ email: "jo.kemp@example.org", name: "Jo Kemp", lineIds: [LINE_A], createPassword: false })).toMatchObject({ ok: true });
    expect(await counts("jo.kemp@example.org")).toEqual({ user: 1, grants: 1, credentials: 0 });
  });
});
