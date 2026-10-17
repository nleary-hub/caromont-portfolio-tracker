/**
 * Providers of Admin > AI settings > Provider keys (ai_provider_keys.provider; the DB check constraint matches), in the
 * card's order. "other" is any OpenAI-compatible endpoint with an https base URL. Client-safe: names and copy only.
 */
export type AiKeyProvider = "openai" | "anthropic" | "xai" | "other";

/** What a row's status dot says. "untested": a key is saved but has not been tested yet. */
export type AiKeyState = "none" | "untested" | "ok" | "rejected" | "unreachable" | "error";

/**
 * The only thing a provider-key action returns: provider, last 4, when it was set, and the status. Never the key or its
 * ciphertext. `status.message` is plain words for the red alert box (never the provider's raw text).
 */
export interface AiKeyActionView {
  provider: AiKeyProvider;
  last4: string;
  setAt: string | null;
  status: { state: AiKeyState; testedAt: string | null; message: string | null };
}

export type AiKeyActionResult = ({ ok: true } & AiKeyActionView) | ({ ok: false; error: string; fieldErrors?: { baseUrl?: string; apiKey?: string; label?: string } } & Partial<AiKeyActionView>);

/** One row of the card, as the page receives it (client-safe: built field by field, never from the stored row). */
export interface AiKeyRowView extends AiKeyActionView {
  set: boolean;
  /** Display name of the admin who set the key ("Jordan Pike"), or null. */
  setBy: string | null;
  /** "other" only: the display name ("Local gateway") and base URL. */
  label: string | null;
  baseUrl: string | null;
  /** The saved key decrypts on this server (false on a preview, where nothing is decrypted). */
  readable: boolean;
  /** Live features using this provider now (the delete dialog's N). */
  featuresUsing: number;
}

export class AiKeyProviders {
  static readonly ALL: readonly AiKeyProvider[] = ["openai", "anthropic", "xai", "other"];
  static readonly KEY_MAX = 500;
  static readonly LABEL_MAX = 40;
  static readonly URL_MAX = 300;

  static parse(v: unknown): AiKeyProvider | null {
    return typeof v === "string" && (AiKeyProviders.ALL as readonly string[]).includes(v) ? (v as AiKeyProvider) : null;
  }

  static label(p: AiKeyProvider): string {
    switch (p) {
      case "openai":
        return "OpenAI";
      case "anthropic":
        return "Anthropic";
      case "xai":
        return "xAI";
      case "other":
        return "Other (OpenAI-compatible)";
    }
  }

  /** The name in pickers: "Other · Local gateway" when "other" has a display name. */
  static pickerName(p: AiKeyProvider, label: string | null): string {
    return p === "other" ? (label ? `Other · ${label}` : "Other") : AiKeyProviders.label(p);
  }

  /** A clean https URL without a trailing slash, or null. Only https (the key travels in a header). */
  static httpsUrl(v: string): string | null {
    const s = v.trim();
    if (!s || s.length > AiKeyProviders.URL_MAX) return null;
    try {
      const u = new URL(s);
      if (u.protocol !== "https:" || u.username || u.password || !u.hostname) return null;
      return u.toString().replace(/\/+$/, "");
    } catch {
      return null;
    }
  }
}

/** Copy of the Provider keys card (design spec, Oct 17, 2026). No em dashes. */
export class AiKeyCopy {
  static readonly TITLE = "Provider keys";
  static readonly CAPTION = "Keys are stored encrypted. Only the last 4 characters are ever shown.";
  static readonly PREVIEW_BANNER = "AI is off on preview deployments. Keys can only be managed in production.";
  static readonly PREVIEW_OFF = "AI is off on preview deployments.";
  static readonly NO_KEY = "No key";
  static readonly NOT_TESTED = "Not tested";
  static readonly TESTING = "Testing…";
  static readonly ROTATING = "Rotating… old key still active";
  static readonly TEST_FAILED = "Test failed";
  static readonly ADD = "Add key";
  static readonly REPLACE_LABEL = "Replace key";
  static readonly ROTATE_LABEL = "Rotate key";
  static readonly KEY_LABEL = "API key";
  static readonly BASE_URL = "Base URL";
  static readonly DISPLAY_NAME = "Display name";
  static readonly DISPLAY_NAME_PLACEHOLDER = "e.g. Local gateway";
  static readonly INVALID_URL = "Enter a full https:// URL";
  static readonly KEY_INVALID = "Paste the whole key, with no spaces.";
  static readonly LABEL_TOO_LONG = "Keep the display name under 40 characters.";
  static readonly ENCRYPTION_MISSING = "Keys can't be saved: AI_SETTINGS_ENCRYPTION_KEY is not set on the server.";
  static readonly SAVE_FAILED = "Couldn't save the key. Try again.";
  static readonly NOT_AUTHORIZED = "Not authorized.";
  static readonly NO_KEY_TO_TEST = "Add a key first.";
  static readonly UNREADABLE = "The saved key can't be read with this server's encryption key. Replace it.";
  static readonly SHOW = "Show key";
  static readonly HIDE = "Hide key";
  static readonly SAVE = "Save";
  static readonly CANCEL = "Cancel";
  static readonly TEST = "Test";
  static readonly REPLACE = "Replace";
  static readonly ROTATE = "Rotate";
  static readonly DELETE = "Delete key";
  static readonly RETRY = "Retry";

  static working(time: string): string {
    return `Working · tested ${time}`;
  }

  static rejected(status: number | null): string {
    return `This key was rejected${status ? ` (${status})` : ""}. Check that it's active and copied in full.`;
  }

  static unreachable(p: AiKeyProvider): string {
    return p === "other" ? "Couldn't reach the base URL." : `Couldn't reach ${AiKeyProviders.label(p)}.`;
  }

  static providerError(p: AiKeyProvider, status: number | null): string {
    return `${AiKeyProviders.label(p)} returned an error${status ? ` (${status})` : ""}. Try again in a minute.`;
  }

  /** The red box text for a stored test state (no HTTP status after a reload). */
  static messageFor(p: AiKeyProvider, state: AiKeyState, status: number | null = null): string | null {
    if (state === "rejected") return AiKeyCopy.rejected(status);
    if (state === "unreachable") return AiKeyCopy.unreachable(p);
    if (state === "error") return AiKeyCopy.providerError(p, status);
    return null;
  }

  static set(date: string, by: string | null): string {
    return by ? `Set ${date} by ${by}` : `Set ${date}`;
  }

  static deleteTitle(p: AiKeyProvider): string {
    return `Delete the ${AiKeyProviders.pickerName(p, null)} key?`;
  }

  static deleteBody(p: AiKeyProvider, n: number): string {
    const name = AiKeyProviders.pickerName(p, null);
    return `Features using ${name} will stop working until you add a key or pick another provider. ${n} ${n === 1 ? "feature uses" : "features use"} it now.`;
  }
}
