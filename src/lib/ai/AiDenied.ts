import type { Viewer } from "@/lib/auth/AdminPolicy";
import { AiKeyShape } from "@/lib/ai/AiKeyShape";

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
 * The counter has one row per (who, action).
 *   - ACTIONS are a closed list: an action that is not on it is counted under one shared label, so a caller cannot make new
 *     action keys.
 *   - WHO is NOT a closed list for people. A person is the verified, signed-in session user (a Viewer from the session
 *     helper, whose address is on the allow list). The number of "person" rows is therefore bounded by the people who can sign
 *     in times the actions listed here, but ONLY under that precondition. This file cannot prove it: an address taken from
 *     request input (a form field, a header, a query) must never be passed as a person; pass it as signed_out. A plausible
 *     address that is passed as a person is stored as given (lowercased), and every distinct one is a new permanent row.
 *   - Wiring requirement (R28, hard, before A3): the wiring pull request must use a branded Viewer type that only the session
 *     reader can create, or a cap on distinct "who" rows; and (R29) it must filter denied rows out of the main audit list.
 *   - Wiring requirement (R32): the deny path must never await the count without a limit. The wiring pull request must use a
 *     lock_timeout or a bounded race around the count, and must add a test with a held row lock. The caller denies either way.
 *   - The other three callers are fixed labels. A person whose address looks like a pasted key is counted as signed out.
 */
export type AiDeniedCaller =
  /** `viewer` must be the verified signed-in session user, never an address read from request input (see the header). */
  | { kind: "person"; viewer: Viewer }
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
   * it adds an entry point. An action outside this list is counted under UNKNOWN_ACTION, so the number of keys cannot grow
   * with a caller's input. A recorded count is never lost or doubled; a count can be skipped under overload (R27).
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

  /**
   * Turn a caller into the "who" label. Precondition: a "person" is the verified session user (see the header); this does not
   * and cannot check that. A person's email is trimmed and lowercased. One that is not a plausible address, or that looks like a
   * pasted key (the shared detector), counts as signed out, so key-shaped text never reaches a table.
   */
  static who(caller: AiDeniedCaller): string {
    switch (caller.kind) {
      case "agent":
        return AiDenied.WHO_AGENT;
      case "voice_ticket":
        return AiDenied.WHO_VOICE_TICKET;
      case "person": {
        const raw = typeof caller.viewer?.email === "string" ? caller.viewer.email.trim() : "";
        const email = raw.toLowerCase();
        if (AiKeyShape.looksLikeKey(raw) || AiKeyShape.looksLikeKey(email)) return AiDenied.WHO_SIGNED_OUT;
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
