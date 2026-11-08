import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { AiKeyCipher } from "@/lib/ai/AiKeyCipher";
import { ReportEnv, type EnvSource } from "@/lib/config/ReportEnv";
import { DriveConnection, type DriveConnectionDb } from "@/lib/report/DriveConnection";
import { DriveConnectText } from "@/lib/report/DriveConnectText";
import { FreezeGuard } from "@/lib/report/FreezeGuard";
import { GoogleDriveClient, type FetchLike } from "@/lib/report/GoogleDriveClient";
import { ReportLog } from "@/lib/report/ReportLog";

/** Why Reconnect Drive can't start here. */
export type DriveConnectProblem = "preview" | "not_configured" | "no_key" | "no_base_url" | "wrong_host";

/** How a Reconnect Drive round trip ended; shown on /reports as ?drive=<code>. */
export type DriveConnectOutcome =
  | DriveConnectProblem
  | "connected"
  | "denied"
  | "bad_state"
  | "exchange_failed"
  | "no_refresh_token"
  | "scope_missing"
  | "save_failed";

export interface DriveConnectStart {
  ok: true;
  /** Google's consent page. */
  url: string;
  /** The value of the short-lived state cookie: "<state>.<PKCE verifier>", both base64url. */
  cookie: string;
}

/**
 * Report freeze > Reconnect Drive: the Owner signs in to Google in the browser and the app keeps the new refresh token
 * (DriveConnection, encrypted). Authorization code flow with a random state (CSRF) and PKCE S256, scope drive.file only,
 * access_type=offline and prompt=consent so Google always returns a refresh token. Uses the same OAuth client as
 * before (GOOGLE_DRIVE_CLIENT_ID and _SECRET): drive.file only sees files that client created, so a new client would
 * lose the report folder. The state and verifier live in an httpOnly cookie scoped to /api/drive for 10 minutes.
 * Nothing here logs or returns a token, a code or Google's response body. Server only.
 */
export class DriveOAuth {
  static readonly AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
  static readonly SCOPE = "https://www.googleapis.com/auth/drive.file";
  static readonly CONNECT_PATH = DriveConnectText.CONNECT_PATH;
  static readonly CALLBACK_PATH = "/api/drive/callback";
  static readonly COOKIE = "drive_oauth";
  static readonly COOKIE_PATH = "/api/drive";
  static readonly COOKIE_MAX_AGE = 600;
  /** Where every round trip ends; the outcome code goes in ?drive=. */
  static readonly RETURN_PATH = "/reports";

  /** The callback address registered on the Google OAuth client, or null without a base URL. */
  static redirectUri(env: EnvSource = process.env): string | null {
    const base = ReportEnv.baseUrl(env);
    return base ? `${base}${DriveOAuth.CALLBACK_PATH}` : null;
  }

  /** Why Reconnect Drive can't run on this server, or null when it can. requestOrigin: the origin the Owner is on. */
  static problem(env: EnvSource = process.env, requestOrigin?: string): DriveConnectProblem | null {
    if (FreezeGuard.disabled() || AiKeyCipher.isPreview(env)) return "preview";
    if (!ReportEnv.driveClient(env)) return "not_configured";
    if (!AiKeyCipher.fromEnv(env).ok) return "no_key";
    const uri = DriveOAuth.redirectUri(env);
    if (!uri) return "no_base_url";
    if (requestOrigin !== undefined && new URL(uri).origin !== requestOrigin) return "wrong_host";
    return null;
  }

  static b64url(bytes: Buffer): string {
    return bytes.toString("base64url");
  }

  /** PKCE S256: base64url(SHA-256(verifier)). */
  static challenge(verifier: string): string {
    return DriveOAuth.b64url(createHash("sha256").update(verifier).digest());
  }

  /** A new state, PKCE verifier and Google consent URL, or why not. random is injectable for tests. */
  static start(env: EnvSource = process.env, requestOrigin?: string, random: (n: number) => Buffer = randomBytes): DriveConnectStart | { ok: false; problem: DriveConnectProblem } {
    const problem = DriveOAuth.problem(env, requestOrigin);
    if (problem) return { ok: false, problem };
    const client = ReportEnv.driveClient(env)!;
    const state = DriveOAuth.b64url(random(32));
    const verifier = DriveOAuth.b64url(random(32));
    const params = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: DriveOAuth.redirectUri(env)!,
      response_type: "code",
      scope: DriveOAuth.SCOPE,
      access_type: "offline",
      prompt: "consent",
      state,
      code_challenge: DriveOAuth.challenge(verifier),
      code_challenge_method: "S256",
    });
    return { ok: true, url: `${DriveOAuth.AUTH_URL}?${params}`, cookie: `${state}.${verifier}` };
  }

  /** The state and verifier from the cookie, or null when it is missing or not in the shape start() wrote. */
  static parseCookie(value: string | undefined | null): { state: string; verifier: string } | null {
    const m = /^([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{43})$/.exec(value ?? "");
    return m ? { state: m[1], verifier: m[2] } : null;
  }

  /** Constant-time compare of the state Google sent back with the cookie's. */
  static stateMatches(expected: string, got: string | null): boolean {
    if (!got) return false;
    const a = Buffer.from(expected);
    const b = Buffer.from(got);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Google's short error code only (never the body), for the log. */
  private static errorCode(json: unknown): string {
    const e = (json as { error?: unknown } | null)?.error;
    return typeof e === "string" && /^[a-z_]{1,40}$/.test(e) ? e : "unknown";
  }

  /** Swaps the authorization code (with the PKCE verifier) for tokens. Null on any failure; logs Google's code only. */
  private static async exchange(env: EnvSource, code: string, verifier: string, fetchImpl: FetchLike): Promise<{ refresh_token?: unknown; scope?: unknown } | null> {
    const client = ReportEnv.driveClient(env)!;
    let status = 0;
    try {
      const res = await fetchImpl(GoogleDriveClient.TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: client.clientId,
          client_secret: client.clientSecret,
          redirect_uri: DriveOAuth.redirectUri(env)!,
          grant_type: "authorization_code",
          code_verifier: verifier,
        }).toString(),
      });
      status = res.status;
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok || json === null || typeof json !== "object") {
        ReportLog.error("drive.connect.exchange_failed", { status, error: DriveOAuth.errorCode(json) });
        return null;
      }
      return json as { refresh_token?: unknown; scope?: unknown };
    } catch {
      ReportLog.error("drive.connect.exchange_failed", { status, error: "network" });
      return null;
    }
  }

  /**
   * The callback: checks the state against the cookie, swaps the code (with the PKCE verifier) for tokens, requires a
   * refresh token and the drive.file scope, and saves the refresh token encrypted. The caller has already checked that
   * the viewer is the Owner, and always clears the cookie.
   */
  static async finish(input: {
    query: URLSearchParams;
    cookie: string | undefined;
    connectedBy: string;
    db: DriveConnectionDb;
    env?: EnvSource;
    fetchImpl?: FetchLike;
    now?: Date;
  }): Promise<DriveConnectOutcome> {
    const env = input.env ?? process.env;
    const problem = DriveOAuth.problem(env);
    if (problem) return problem;
    const saved = DriveOAuth.parseCookie(input.cookie);
    if (!saved || !DriveOAuth.stateMatches(saved.state, input.query.get("state"))) {
      ReportLog.warn("drive.connect.bad_state", { cookie: saved ? "present" : "missing" });
      return "bad_state";
    }
    if (input.query.get("error")) {
      ReportLog.warn("drive.connect.denied", { error: DriveOAuth.errorCode({ error: input.query.get("error") }) });
      return "denied";
    }
    const code = input.query.get("code");
    if (!code) return "bad_state";

    const json = await DriveOAuth.exchange(env, code, saved.verifier, input.fetchImpl ?? fetch);
    if (!json) return "exchange_failed";

    const scopes = typeof json.scope === "string" ? json.scope.split(" ") : [];
    if (!scopes.includes(DriveOAuth.SCOPE)) {
      ReportLog.warn("drive.connect.scope_missing");
      return "scope_missing";
    }
    const refreshToken = typeof json.refresh_token === "string" ? json.refresh_token.trim() : "";
    if (!refreshToken) {
      ReportLog.warn("drive.connect.no_refresh_token");
      return "no_refresh_token";
    }
    try {
      await DriveConnection.save(input.db, refreshToken, input.connectedBy, env, input.now ?? new Date());
    } catch {
      ReportLog.error("drive.connect.save_failed");
      return "save_failed";
    }
    ReportLog.info("drive.connect.ok");
    return "connected";
  }
}
