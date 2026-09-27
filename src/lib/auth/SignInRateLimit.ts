/** Runs one SQL statement with positional parameters and returns its rows (Prisma's $queryRawUnsafe, or PGlite in tests). */
export type SqlRunner = (sql: string, ...params: unknown[]) => Promise<Array<{ count: number }>>;

export interface RateLimitRule {
  prefix: "ip" | "email";
  max: number;
  windowMs: number;
}

/**
 * Rate limit for the password sign-in endpoint, on top of the per-account lockout (5 failures = 15 minutes). Every
 * attempt, right or wrong, counts against both the caller's IP and the typed email in a fixed 15 minute window:
 * - per IP: 30 attempts (a shared hospital network can have several people signing in at once)
 * - per email: 10 attempts
 * The counter lives in Postgres (password_rate_limit) and is bumped with one atomic upsert, so it holds across
 * serverless instances and parallel requests. Over the limit, the attempt is refused before any password check and
 * the person sees the same "Too many attempts" message as the lockout.
 */
export class SignInRateLimit {
  static readonly WINDOW_MS = 15 * 60 * 1000;
  static readonly RULES: readonly RateLimitRule[] = [
    { prefix: "ip", max: 30, windowMs: SignInRateLimit.WINDOW_MS },
    { prefix: "email", max: 10, windowMs: SignInRateLimit.WINDOW_MS },
  ];

  /**
   * $1 key, $2 now, $3 window start cutoff (now - window). A row whose window began before the cutoff starts over at 1.
   * Returns the count after this attempt.
   */
  static readonly HIT_SQL = `INSERT INTO "password_rate_limit" ("key", "windowStart", "count") VALUES ($1, $2, 1)
ON CONFLICT ("key") DO UPDATE SET
  "count" = CASE WHEN "password_rate_limit"."windowStart" <= $3 THEN 1 ELSE "password_rate_limit"."count" + 1 END,
  "windowStart" = CASE WHEN "password_rate_limit"."windowStart" <= $3 THEN $2 ELSE "password_rate_limit"."windowStart" END
RETURNING "count"`;

  /** Old rows are swept now and then (1 in 50 attempts), so the table stays small without a cron job. */
  static readonly SWEEP_SQL = `DELETE FROM "password_rate_limit" WHERE "windowStart" < $1`;

  /** The client IP. Vercel sets x-forwarded-for itself (the first entry is the client), so it can't be spoofed there. */
  static clientIp(headers: Headers | null | undefined): string | null {
    const fwd = headers?.get("x-forwarded-for")?.split(",")[0]?.trim();
    const ip = fwd || headers?.get("x-real-ip")?.trim() || "";
    return ip && ip.length <= 64 ? ip.toLowerCase() : null;
  }

  static keys(ip: string | null, email: string): Array<{ key: string; rule: RateLimitRule }> {
    const out: Array<{ key: string; rule: RateLimitRule }> = [];
    for (const rule of SignInRateLimit.RULES) {
      const value = rule.prefix === "ip" ? ip : email;
      if (value) out.push({ key: `${rule.prefix}:${value}`, rule });
    }
    return out;
  }

  /** Count this attempt against every key; true when any key is over its limit. */
  static async overLimit(run: SqlRunner, ip: string | null, email: string, now: Date = new Date(), random: () => number = Math.random): Promise<boolean> {
    let over = false;
    for (const { key, rule } of SignInRateLimit.keys(ip, email)) {
      const rows = await run(SignInRateLimit.HIT_SQL, key, now, new Date(now.getTime() - rule.windowMs));
      if (Number(rows[0]?.count ?? 0) > rule.max) over = true;
    }
    if (random() < 0.02) await run(SignInRateLimit.SWEEP_SQL, new Date(now.getTime() - 24 * 60 * 60 * 1000)).catch(() => []);
    return over;
  }
}
