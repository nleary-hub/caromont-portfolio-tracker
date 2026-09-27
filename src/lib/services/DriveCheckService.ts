import { ReportEnv, type EnvSource } from "@/lib/config/ReportEnv";
import { DriveError, GoogleDriveClient, type FetchLike } from "@/lib/report/GoogleDriveClient";
import { ReportLog } from "@/lib/report/ReportLog";

/** Which step failed: setup (not configured), save (token, folder or upload), read (read back), delete (clean up). */
export type DriveCheckStep = "setup" | "save" | "read" | "delete";

export type DriveCheckResult =
  | { ok: true; message: string; at: string; folder: { name: string; id: string } }
  | { ok: false; step: DriveCheckStep; message: string; detail: string | null; folder?: { name: string; id: string } };

/**
 * Admin > Report freeze > Check Drive: proves the production Drive setup works without a freeze. Uses the same
 * settings and client as the freeze delivery (ReportEnv.drive, GoogleDriveClient): saves a small plain text file in
 * the report folder, reads it back, deletes it. Returns the folder name and id and a message per step, never a
 * secret. No email, no freeze. No em dashes in the copy.
 */
export class DriveCheckService {
  static readonly FILE_PREFIX = "portfolio-drive-setup-test-";
  static readonly NOT_CONFIGURED = "Drive isn't set up on this server.";
  static readonly NOT_CONFIGURED_DETAIL = "Add GOOGLE_DRIVE_CLIENT_ID, GOOGLE_DRIVE_CLIENT_SECRET and GOOGLE_DRIVE_REFRESH_TOKEN, then redeploy.";
  static readonly READ_FAILED = "Saved a test file, but couldn't read it back.";
  static readonly MISMATCH_DETAIL = "The file read back didn't match what was saved.";

  /** The folder shown next to the button: the app's own folder, or a generic name when GOOGLE_DRIVE_FOLDER_ID picks one. */
  static folderLabel(env: EnvSource = process.env): string {
    return ReportEnv.drive(env)?.folderId ? "the report folder" : GoogleDriveClient.FOLDER_NAME;
  }

  static help(folder: string): string {
    return `Saves a small test file to ${folder}, then removes it. Nothing is frozen or sent.`;
  }

  static saveFailed(folder: string): string {
    return `Couldn't save a test file to ${folder}.`;
  }

  static deleteFailed(folder: string): string {
    return `Drive saves are working, but the test file couldn't be removed. Delete it from ${folder}.`;
  }

  static ok(time: string): string {
    return `Drive is working. A test file was saved, read back and removed at ${time}.`;
  }

  /** e.g. "1:42 PM" in America/New_York. */
  static time(at: Date): string {
    return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" }).format(at);
  }

  static fileName(now: Date): string {
    return `${DriveCheckService.FILE_PREFIX}${now.toISOString().replace(/[:.]/g, "-")}.txt`;
  }

  private static detail(e: unknown): string {
    return e instanceof DriveError ? e.message : "Unexpected error. Try again.";
  }

  static async run(env: EnvSource = process.env, fetchImpl: FetchLike = fetch, now: () => Date = () => new Date()): Promise<DriveCheckResult> {
    const drive = ReportEnv.drive(env);
    if (!drive) return { ok: false, step: "setup", message: DriveCheckService.NOT_CONFIGURED, detail: DriveCheckService.NOT_CONFIGURED_DETAIL };
    const client = new GoogleDriveClient(drive, fetchImpl);
    const started = now();
    const text = `Drive setup test from the portfolio tracker at ${started.toISOString()}. Safe to delete.`;
    let folder: { name: string; id: string } | undefined;
    const fail = (step: DriveCheckStep, message: string, e: unknown): DriveCheckResult => {
      ReportLog.error("drive.check.failed", { step, folderId: folder?.id ?? null, error: e instanceof Error ? e.message : String(e) });
      return { ok: false, step, message, detail: typeof e === "string" ? e : DriveCheckService.detail(e), folder };
    };

    let token: string;
    let fileId: string;
    try {
      token = await client.accessToken();
      const id = await client.folderId(token);
      folder = { id, name: await client.fileName(token, id) };
      const up = await client.uploadTo(token, id, [{ name: DriveCheckService.fileName(started), contentType: "text/plain", bytes: new TextEncoder().encode(text) }]);
      fileId = up.files[0].id;
    } catch (e) {
      return fail("save", DriveCheckService.saveFailed(folder?.name ?? DriveCheckService.folderLabel(env)), e);
    }

    let readError: unknown = null;
    try {
      if ((await client.readText(token, fileId)) !== text) readError = DriveCheckService.MISMATCH_DETAIL;
    } catch (e) {
      readError = e;
    }
    // Always try to remove the test file, even when the read failed.
    try {
      await client.deleteFile(token, fileId);
    } catch (e) {
      if (readError === null) return fail("delete", DriveCheckService.deleteFailed(folder.name), e);
    }
    if (readError !== null) return fail("read", DriveCheckService.READ_FAILED, readError);

    const at = now();
    ReportLog.info("drive.check.ok", { folderId: folder.id });
    return { ok: true, message: DriveCheckService.ok(DriveCheckService.time(at)), at: at.toISOString(), folder };
  }
}
