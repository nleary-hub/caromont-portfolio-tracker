import type { DriveConnectOutcome } from "@/lib/report/DriveOAuth";

export interface DriveConnectMessage {
  ok: boolean;
  text: string;
}

/**
 * The line Report freeze shows after Reconnect Drive sends the Owner back with ?drive=<code>. Plain words, no secret and
 * nothing from Google's answer. An unknown code shows nothing (the query string is not trusted). No em dashes.
 */
export class DriveConnectText {
  static readonly LABEL = "Reconnect Drive";
  /** The form's action (DriveOAuth.CONNECT_PATH points here, so the client bundle never imports node:crypto). */
  static readonly CONNECT_PATH = "/api/drive/connect";
  static readonly HELP = "Sign in to Google again to renew the app's Drive access. The app keeps the new sign-in encrypted.";
  static readonly PREVIEW_OFF = "Reconnecting Drive is turned off on preview deployments.";

  private static readonly MESSAGES: Record<DriveConnectOutcome, DriveConnectMessage> = {
    connected: { ok: true, text: "Drive is reconnected. Press Check Drive to confirm saves work." },
    denied: { ok: false, text: "Google sign-in was cancelled, so Drive wasn't reconnected." },
    bad_state: { ok: false, text: "That sign-in couldn't be verified, so nothing was saved. Press Reconnect Drive again." },
    exchange_failed: { ok: false, text: "Google didn't accept the sign-in, so nothing was saved. Press Reconnect Drive again." },
    no_refresh_token: { ok: false, text: "Google didn't return a lasting sign-in, so nothing was saved. Press Reconnect Drive again." },
    scope_missing: { ok: false, text: "Drive access wasn't granted. Press Reconnect Drive again and leave the Google Drive box ticked." },
    save_failed: { ok: false, text: "The sign-in worked, but the app couldn't save it. Try again." },
    preview: { ok: false, text: DriveConnectText.PREVIEW_OFF },
    not_configured: { ok: false, text: "Drive isn't set up on this server (no Google client ID or secret)." },
    no_key: { ok: false, text: "The app's encryption key isn't set, so it can't keep a Drive sign-in." },
    no_base_url: { ok: false, text: "The app's address isn't set (APP_BASE_URL), so Google can't send you back." },
    wrong_host: { ok: false, text: "Open the tracker at its main address and press Reconnect Drive there." },
  };

  /** The note next to the button once Drive was connected in the app, e.g. "Connected in the app Nov 4, 2026, 9:12 AM ET." */
  static connected(when: string): string {
    return `Connected in the app ${when}.`;
  }

  /** The setup line under the button: the exact address the Google OAuth client must list (not a secret). */
  static redirectNote(uri: string): string {
    return `Google's OAuth client must list ${uri} as an authorized redirect URI.`;
  }

  /** mainHost: the app's own host (APP_BASE_URL), named in the wrong-host line so the Owner knows where to go. */
  static message(code: string | string[] | undefined, mainHost?: string | null): DriveConnectMessage | null {
    if (typeof code !== "string" || !Object.hasOwn(DriveConnectText.MESSAGES, code)) return null;
    if (code === "wrong_host" && mainHost) return { ok: false, text: `Open the tracker at ${mainHost} and press Reconnect Drive there. Google only sends you back to that address.` };
    return DriveConnectText.MESSAGES[code as DriveConnectOutcome];
  }
}
