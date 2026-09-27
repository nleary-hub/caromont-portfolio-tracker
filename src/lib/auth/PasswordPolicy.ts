import { PasswordCopy } from "@/lib/auth/PasswordCopy";

/** One live rule on the set-password checklist. */
export interface PasswordRule {
  id: "length" | "notEmail" | "match";
  label: string;
  met: boolean;
}

/**
 * Password rules for email and password sign-in: at least 12 characters (counted as characters, so accented letters and
 * emoji count once), not the email address. An upper bound keeps a huge paste from tying up the hasher. No composition
 * rules: length is what matters (NIST SP 800-63B).
 */
export class PasswordPolicy {
  static readonly MIN_LENGTH = 12;
  static readonly MAX_LENGTH = 256;

  static charCount(password: string): number {
    return [...password].length;
  }

  /** The checklist shown while someone types (also what the server enforces, plus "not the temporary one"). */
  static rules(password: string, confirm: string, email: string): PasswordRule[] {
    const n = PasswordPolicy.charCount(password);
    return [
      { id: "length", label: PasswordCopy.RULE_LENGTH, met: n >= PasswordPolicy.MIN_LENGTH && n <= PasswordPolicy.MAX_LENGTH && password.trim().length > 0 },
      { id: "notEmail", label: PasswordCopy.RULE_NOT_EMAIL, met: n > 0 && password.trim().toLowerCase() !== email.trim().toLowerCase() },
      { id: "match", label: PasswordCopy.RULE_MATCH, met: n > 0 && password === confirm },
    ];
  }

  /** Copy for the first rule the new password breaks, or null when it is fine. */
  static problem(password: unknown, confirm: unknown, email = ""): string | null {
    if (typeof password !== "string" || PasswordPolicy.charCount(password) < PasswordPolicy.MIN_LENGTH || !password.trim()) return PasswordCopy.TOO_SHORT;
    if (PasswordPolicy.charCount(password) > PasswordPolicy.MAX_LENGTH) return PasswordCopy.TOO_LONG;
    if (email && password.trim().toLowerCase() === email.trim().toLowerCase()) return PasswordCopy.IS_EMAIL;
    if (confirm !== password) return PasswordCopy.MISMATCH;
    return null;
  }

  /** Whether a typed sign-in password is worth hashing at all (anything else is a plain failure). */
  static isPlausible(password: unknown): password is string {
    return typeof password === "string" && password.length > 0 && PasswordPolicy.charCount(password) <= PasswordPolicy.MAX_LENGTH;
  }
}
