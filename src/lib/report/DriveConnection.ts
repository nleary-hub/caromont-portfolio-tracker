import { AiKeyCipher } from "@/lib/ai/AiKeyCipher";
import { ReportEnv, type DriveEnv, type EnvSource } from "@/lib/config/ReportEnv";
import { Db } from "@/lib/db/Db";
import { ReportLog } from "@/lib/report/ReportLog";

/** Where the refresh token in use came from: Reconnect Drive (saved in the database) or GOOGLE_DRIVE_REFRESH_TOKEN. */
export type DriveTokenSource = "connected" | "env";

export type ResolvedDrive = DriveEnv & { source: DriveTokenSource };

/** The one table this needs (Prisma's drive_connection delegate, or a fake in tests). */
export interface DriveConnectionDb {
  driveConnection: {
    findUnique(args: { where: { id: number } }): Promise<{ refreshTokenCiphertext: string; connectedAt: Date; connectedBy: string } | null>;
    upsert(args: {
      where: { id: number };
      create: { id: number; refreshTokenCiphertext: string; connectedAt: Date; connectedBy: string };
      update: { refreshTokenCiphertext: string; connectedAt: Date; connectedBy: string };
    }): Promise<unknown>;
  };
}

/**
 * The Google Drive refresh token saved by Report freeze > Reconnect Drive (migration 0073, one row). Encrypted at rest
 * with AiKeyCipher (key AI_SETTINGS_ENCRYPTION_KEY, its own binding), so the database alone can't read it. The plain
 * token never goes to a log, Sentry, the browser or a URL. The client ID and secret stay in the environment.
 *
 * resolve() is what the freeze delivery and Check Drive use: the saved token first, then GOOGLE_DRIVE_REFRESH_TOKEN.
 * Anything wrong with the saved one (no key, preview, unreadable, table missing) falls back to the env var. Server only.
 */
export class DriveConnection {
  static readonly BINDING = "drive_connection.refreshToken";
  private static readonly ID = 1;

  /** The app database, opened only when a caller actually reads or writes the row (DATABASE_URL may be unset in tests). */
  static readonly appDb: DriveConnectionDb = {
    get driveConnection() {
      return Db.client.driveConnection as unknown as DriveConnectionDb["driveConnection"];
    },
  };

  /** Encrypts and saves a refresh token as the current Drive connection. Throws when the encryption key can't be used. */
  static async save(db: DriveConnectionDb, refreshToken: string, connectedBy: string, env: EnvSource = process.env, now: Date = new Date()): Promise<void> {
    const key = AiKeyCipher.fromEnv(env);
    if (!key.ok) throw new Error(`drive_connection_key_${key.problem}`);
    const refreshTokenCiphertext = AiKeyCipher.encrypt(refreshToken, key.key, DriveConnection.BINDING);
    const row = { refreshTokenCiphertext, connectedAt: now, connectedBy };
    await db.driveConnection.upsert({ where: { id: DriveConnection.ID }, create: { id: DriveConnection.ID, ...row }, update: row });
  }

  /** The saved refresh token in plain text, or null when there is none or it can't be read. Never log the result. */
  static async storedToken(db: DriveConnectionDb, env: EnvSource = process.env): Promise<string | null> {
    const key = AiKeyCipher.fromEnv(env);
    if (!key.ok) return null;
    let row: { refreshTokenCiphertext: string } | null;
    try {
      row = await db.driveConnection.findUnique({ where: { id: DriveConnection.ID } });
    } catch {
      ReportLog.warn("drive.connection.read_failed");
      return null;
    }
    if (!row) return null;
    const plain = AiKeyCipher.decrypt(row.refreshTokenCiphertext, key.key, DriveConnection.BINDING);
    if (plain === null) ReportLog.warn("drive.connection.undecryptable");
    return plain?.trim() ? plain : null;
  }

  /** When and by whom Drive was last connected in the app (no token), or null. */
  static async status(db: DriveConnectionDb): Promise<{ connectedAt: Date; connectedBy: string } | null> {
    try {
      const row = await db.driveConnection.findUnique({ where: { id: DriveConnection.ID } });
      return row ? { connectedAt: row.connectedAt, connectedBy: row.connectedBy } : null;
    } catch {
      return null;
    }
  }

  /** Drive settings for a save: the client from the environment with the saved token, else the env token, else null. */
  static async resolve(env: EnvSource, db: DriveConnectionDb): Promise<ResolvedDrive | null> {
    const client = ReportEnv.driveClient(env);
    if (!client) return null;
    const stored = await DriveConnection.storedToken(db, env);
    if (stored) return { ...client, refreshToken: stored, source: "connected" };
    const fromEnv = ReportEnv.drive(env);
    return fromEnv ? { ...fromEnv, source: "env" } : null;
  }
}
