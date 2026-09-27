import { randomInt } from "node:crypto";

/** Temporary passwords an admin hands out (server only). The person must replace it at first sign-in. */
export class TemporaryPassword {
  /** Letters and digits that are hard to misread (no 0/O, 1/l/I, 5/S, 8/B). */
  static readonly ALPHABET = "abcdefghjkmnpqrstuvwxyzACDEFGHJKLMNPQRTUVWXY234679";

  /** Like "k7Qm-3xPt-9RwZ-4hNc": 4 groups of 4 (19 characters, about 90 bits of randomness from crypto.randomInt). */
  static generate(): string {
    const a = TemporaryPassword.ALPHABET;
    const group = () => Array.from({ length: 4 }, () => a[randomInt(a.length)]).join("");
    return [group(), group(), group(), group()].join("-");
  }
}
