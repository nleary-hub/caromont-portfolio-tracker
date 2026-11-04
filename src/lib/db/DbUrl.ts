/**
 * Connection-string helpers for the runtime database client.
 *
 * pg 8 (through pg-connection-string 2.x) treats `sslmode=prefer`, `require` and `verify-ca` as aliases for
 * `verify-full`: TLS on, certificate checked, host name checked. It also prints a SECURITY WARNING on every cold
 * start because pg 9 will switch those modes to the weaker libpq meaning (`require` stops checking the certificate).
 * Neon and Vercel hand out URLs with `sslmode=require`, so production logged that warning on every new function.
 *
 * `strictSsl` rewrites those three modes to `verify-full`, the mode pg 8 already uses for them. Today's behaviour is
 * unchanged, the warning stops, and the pg 9 upgrade cannot quietly weaken the connection. Anything else is left as it
 * is: no sslmode, `disable`, `no-verify`, `verify-full`, or a URL that opts into libpq semantics with
 * `uselibpqcompat=true` (that caller has made an explicit choice).
 */
export class DbUrl {
  private static readonly ALIASED = /([?&]sslmode=)(prefer|require|verify-ca)(?=&|#|$)/i;
  private static readonly LIBPQ_COMPAT = /[?&]uselibpqcompat=true(?=&|#|$)/i;

  static strictSsl(connectionString: string): string {
    if (DbUrl.LIBPQ_COMPAT.test(connectionString)) return connectionString;
    return connectionString.replace(DbUrl.ALIASED, "$1verify-full");
  }
}
