/**
 * Denied AI attempts: the fixed vocabulary and the pure rules (migration 0071, table ai_denied_counter; item 10a, cron
 * option (b)). Client-safe: names, lists and text only. Nothing here reads or writes the database.
 *
 * How a denial is logged, in short (the database work is in AiDeniedService):
 *   - the first denial of a person for an action in a window writes its own history row at once;
 *   - every further denial in that window adds one to a small counter row and writes no history row;
 *   - when a new window opens for the same person and action, the counter is folded into one history row and reset, in one
 *     transaction;
 *   - the Owner's history list reads the counter table live, so a count that has not folded yet is always visible.
 * No daily job is involved and nothing under the cron routes is used.
 *
 * The counter has one row per (who, action). Both parts come from this file's closed vocabulary, never from text the
 * caller supplies, so the number of rows stays bounded by the people who can sign in times the actions listed here.
 */
export type AiDeniedCaller =
  | { kind: "person"; email: string }
  | { kind: "signed_out" }
  | { kind: "agent" }
  | { kind: "voice_ticket" };

export class AiDenied {
  /** A denial window is 10 minutes (spec section 3.6: "set at build"). */
  static readonly WINDOW_MS = 10 * 60 * 1000;

  /** The shared label for any action this list does not know. It keeps the count instead of dropping it. */
  static readonly UNKNOWN_ACTION = "unknown_action";

  static readonly WHO_SIGNED_OUT = "signed out";
  static readonly WHO_AGENT = "agent";
  static readonly WHO_VOICE_TICKET = "voice ticket";

  /**
   * The Owner-only actions of section 3.6 that can be denied. Each matches the database shape rule
   * (lowercase letters, digits and . _ : - only, at most 80 characters). A later pull request adds its own action here when
   * it adds an entry point. An action outside this list is counted under UNKNOWN_ACTION, never dropped, so the number of
   * keys cannot grow with a caller's input.
   */
  static readonly ACTIONS: readonly string[] = [
    "key_add", "key_test", "key_rotate", "key_remove", "legacy_key_clear", "key_note_edit", "provider_add",
    "fallback_set", "fallback_clear", "fallback_ack", "cap_set", "cap_revert",
    "model_add", "model_enable", "model_disable", "model_archive", "model_restore", "model_test", "model_efforts_set", "model_list_refresh",
    "category_set", "effort_set", "override_set", "override_clear",
    "price_edit", "price_refresh", "price_correct", "backfill_run",
    "kill_switch", "step_up",
  ];

  /** The longest email the counter table accepts (its who_length CHECK allows 1 to 254 characters). */
  static readonly WHO_MAX = 254;

  /** Turn a caller into one of the bounded "who" labels. A person's email is trimmed and lowercased; one that is not a plausible address counts as signed out. */
  static who(caller: AiDeniedCaller): string {
    switch (caller.kind) {
      case "agent":
        return AiDenied.WHO_AGENT;
      case "voice_ticket":
        return AiDenied.WHO_VOICE_TICKET;
      case "person": {
        const email = typeof caller.email === "string" ? caller.email.trim().toLowerCase() : "";
        return AiDenied.plausibleEmail(email) ? email : AiDenied.WHO_SIGNED_OUT;
      }
      default:
        return AiDenied.WHO_SIGNED_OUT;
    }
  }

  private static plausibleEmail(email: string): boolean {
    return email.length > 0 && email.length <= AiDenied.WHO_MAX && /^[^\s@]+@[^\s@]+$/.test(email);
  }

  /** The counter key's action part: the action when it is on the list, else the shared unknown label. */
  static action(action: string): string {
    return AiDenied.ACTIONS.includes(action) ? action : AiDenied.UNKNOWN_ACTION;
  }

  /** The text of a folded history row and of a live list line. `since` is the start of the window the count belongs to. */
  static moreText(count: number, since: Date): string {
    return `${count} more denied ${count === 1 ? "attempt" : "attempts"} since ${since.toISOString()}`;
  }

  /** The new value of a first-denial history row, and the prefix of a folded one. */
  static foldedValue(action: string, count: number, since: Date): string {
    return `${action}: ${AiDenied.moreText(count, since)}`;
  }
}
