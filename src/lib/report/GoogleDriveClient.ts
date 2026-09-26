import type { DriveEnv } from "@/lib/config/ReportEnv";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface DriveFile {
  name: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface DriveUploadResult {
  folderId: string;
  files: { name: string; id: string; webViewLink: string | null }[];
}

export class DriveError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "DriveError";
  }
}

/**
 * Minimal Google Drive v3 client over fetch (no SDK): refresh-token exchange, find-or-create the
 * app's folder, multipart upload. Scope drive.file: the app only sees files and folders it created,
 * so a hand-made folder id only works if the app created it (otherwise leave the folder id empty).
 */
export class GoogleDriveClient {
  static readonly TOKEN_URL = "https://oauth2.googleapis.com/token";
  static readonly FILES_URL = "https://www.googleapis.com/drive/v3/files";
  static readonly UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";
  static readonly FOLDER_NAME = "Cardiac Status Reports";
  static readonly FOLDER_MIME = "application/vnd.google-apps.folder";

  constructor(
    private readonly env: DriveEnv,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private static async fail(res: Response, what: string): Promise<never> {
    let detail = "";
    try {
      detail = (await res.text()).slice(0, 300);
    } catch {
      /* ignore */
    }
    throw new DriveError(`${what} failed (HTTP ${res.status})${detail ? `: ${detail}` : ""}`, res.status);
  }

  async accessToken(): Promise<string> {
    const res = await this.fetchImpl(GoogleDriveClient.TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.env.clientId,
        client_secret: this.env.clientSecret,
        refresh_token: this.env.refreshToken,
        grant_type: "refresh_token",
      }).toString(),
    });
    if (!res.ok) return GoogleDriveClient.fail(res, "Token refresh");
    const json = (await res.json()) as { access_token?: string };
    if (!json.access_token) throw new DriveError("Token refresh returned no access_token");
    return json.access_token;
  }

  async folderId(token: string): Promise<string> {
    if (this.env.folderId) return this.env.folderId;
    const q = `name = '${GoogleDriveClient.FOLDER_NAME}' and mimeType = '${GoogleDriveClient.FOLDER_MIME}' and trashed = false`;
    const list = await this.fetchImpl(`${GoogleDriveClient.FILES_URL}?${new URLSearchParams({ q, fields: "files(id)", pageSize: "1" })}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!list.ok) return GoogleDriveClient.fail(list, "Folder lookup");
    const found = ((await list.json()) as { files?: { id: string }[] }).files?.[0];
    if (found) return found.id;
    const created = await this.fetchImpl(`${GoogleDriveClient.FILES_URL}?fields=id`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: GoogleDriveClient.FOLDER_NAME, mimeType: GoogleDriveClient.FOLDER_MIME }),
    });
    if (!created.ok) return GoogleDriveClient.fail(created, "Folder create");
    return ((await created.json()) as { id: string }).id;
  }

  static multipartBody(meta: object, file: DriveFile, boundary: string): Uint8Array {
    const head = Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n` +
        `--${boundary}\r\nContent-Type: ${file.contentType}\r\n\r\n`,
    );
    const tail = Buffer.from(`\r\n--${boundary}--`);
    return new Uint8Array(Buffer.concat([head, Buffer.from(file.bytes), tail]));
  }

  async upload(files: DriveFile[]): Promise<DriveUploadResult> {
    const token = await this.accessToken();
    const folderId = await this.folderId(token);
    const out: DriveUploadResult["files"] = [];
    for (const file of files) {
      const boundary = `report-${Math.random().toString(36).slice(2)}`;
      const res = await this.fetchImpl(`${GoogleDriveClient.UPLOAD_URL}?uploadType=multipart&fields=id,webViewLink`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` },
        body: GoogleDriveClient.multipartBody({ name: file.name, parents: [folderId] }, file, boundary) as unknown as BodyInit,
      });
      if (!res.ok) return GoogleDriveClient.fail(res, `Upload of ${file.name}`);
      const json = (await res.json()) as { id: string; webViewLink?: string };
      out.push({ name: file.name, id: json.id, webViewLink: json.webViewLink ?? null });
    }
    return { folderId, files: out };
  }
}
