import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DriveConnection, type DriveConnectionDb } from "@/lib/report/DriveConnection";
import { refusal, registryHarness, type RegistryHarness } from "./helpers/PgRegistryDb";

// Migration 0073 on a real Postgres (PGlite, in memory) through the real Prisma client: one row at most, only the
// encrypted form fits, and DriveConnection saves and reads it back. Fictional values only.
const KEY = Buffer.alloc(32, 3).toString("base64");
const ENV = { GOOGLE_DRIVE_CLIENT_ID: "cid", GOOGLE_DRIVE_CLIENT_SECRET: "cs", GOOGLE_DRIVE_REFRESH_TOKEN: "env-token", AI_SETTINGS_ENCRYPTION_KEY: KEY };

let h: RegistryHarness;
beforeAll(async () => {
  h = await registryHarness();
});
afterAll(async () => {
  await h?.stop();
});

describe("0073 drive_connection", () => {
  it("saves, replaces and resolves through Prisma; the stored value is never the plain token", async () => {
    const db = h.prisma as unknown as DriveConnectionDb;
    expect((await DriveConnection.resolve(ENV, db))?.source).toBe("env");
    await DriveConnection.save(db, "1//first-fiction", "owner@example.test", ENV);
    await DriveConnection.save(db, "1//second-fiction", "owner@example.test", ENV);
    const rows = await h.pg.query<{ id: number; refreshTokenCiphertext: string }>('SELECT id, "refreshTokenCiphertext" FROM drive_connection');
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].id).toBe(1);
    expect(rows.rows[0].refreshTokenCiphertext).toMatch(/^v1:/);
    expect(rows.rows[0].refreshTokenCiphertext).not.toContain("fiction");
    expect(await DriveConnection.resolve(ENV, db)).toMatchObject({ refreshToken: "1//second-fiction", source: "connected" });
    expect((await DriveConnection.status(db))?.connectedBy).toBe("owner@example.test");
  });

  it("refuses a second row, a plain-text token and a blank connectedBy", async () => {
    expect(await refusal(h.pg, `INSERT INTO drive_connection (id, "refreshTokenCiphertext", "connectedBy") VALUES (2, 'v1:a:b:c', 'owner@example.test')`)).toMatch(/drive_connection_single_row/);
    expect(await refusal(h.pg, `UPDATE drive_connection SET "refreshTokenCiphertext" = '1//plain-fiction'`)).toMatch(/drive_connection_ciphertext_shape/);
    expect(await refusal(h.pg, `UPDATE drive_connection SET "connectedBy" = ''`)).toMatch(/drive_connection_connected_by/);
  });
});
