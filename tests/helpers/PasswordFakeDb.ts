/* In-memory stand-in for the Prisma models password sign-in uses (kept apart from FakeDb, which other PRs change). */
type Row = Record<string, unknown>;

class Table {
  rows = new Map<string, Row>();
  constructor(private readonly key: (r: Row) => string) {}

  private static matches(row: Row, where: Row = {}): boolean {
    return Object.entries(where).every(([k, cond]) => {
      const v = row[k];
      if (cond && typeof cond === "object" && !(cond instanceof Date)) {
        const c = cond as { in?: unknown[]; lte?: Date | number; gte?: number };
        if (c.in) return c.in.includes(v);
        if (c.lte !== undefined) return v != null && (v as Date | number) <= c.lte;
        if (c.gte !== undefined) return v != null && (v as number) >= c.gte;
      }
      return v === cond;
    });
  }

  private static apply(row: Row, data: Row): Row {
    const next = { ...row };
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === "object" && "increment" in (v as Row)) next[k] = ((next[k] as number) ?? 0) + ((v as { increment: number }).increment);
      else next[k] = v;
    }
    return next;
  }

  findUnique = async ({ where }: { where: Row; include?: Row }) => [...this.rows.values()].find((r) => Table.matches(r, where)) ?? null;
  findFirst = this.findUnique;
  findMany = async ({ where }: { where?: Row } = {}) => [...this.rows.values()].filter((r) => Table.matches(r, where));
  create = async ({ data }: { data: Row }) => {
    const row = { ...this.defaults(), ...data };
    const k = this.key(row);
    if (this.rows.has(k)) throw Object.assign(new Error("Unique constraint"), { code: "P2002" });
    this.rows.set(k, row);
    return row;
  };
  update = async ({ where, data }: { where: Row; data: Row }) => {
    const row = await this.findUnique({ where });
    if (!row) throw Object.assign(new Error("Not found"), { code: "P2025" });
    const next = Table.apply(row, data);
    this.rows.set(this.key(next), next);
    return next;
  };
  updateMany = async ({ where, data }: { where: Row; data: Row }) => {
    const hits = await this.findMany({ where });
    for (const r of hits) this.rows.set(this.key(r), Table.apply(r, data));
    return { count: hits.length };
  };
  upsert = async ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
    const row = await this.findUnique({ where });
    return row ? this.update({ where, data: update }) : this.create({ data: create });
  };
  deleteMany = async ({ where }: { where: Row }) => {
    const hits = await this.findMany({ where });
    for (const r of hits) this.rows.delete(this.key(r));
    return { count: hits.length };
  };
  defaults(): Row {
    return {};
  }
  all(): Row[] {
    return [...this.rows.values()];
  }
}

let seq = 0;

export class PasswordFakeDb {
  appUser = new Table((r) => r.email as string);
  serviceLine = new Table((r) => r.id as string);
  serviceLineAccessGrant = new Table((r) => `${r.email}|${r.serviceLineId}`);
  serviceLineAccessHistory = new Table(() => `h${++seq}`);
  passwordCredential = new Table((r) => r.email as string);
  passwordCredentialHistory = new Table(() => `p${++seq}`);
  passwordSignInAttempt = new Table((r) => r.email as string);
  /** password_rate_limit rows: key -> { windowStart, count } */
  rateLimit = new Map<string, { windowStart: Date; count: number }>();
  failNextTransaction = false;

  constructor() {
    const include = this.passwordCredential.findUnique;
    // `include: { user: true }` joins the app_user row.
    this.passwordCredential.findUnique = async (args) => {
      const row = await include(args);
      return row && args.include?.user ? { ...row, user: await this.appUser.findUnique({ where: { email: row.email } }) } : row;
    };
    this.passwordCredential.defaults = () => ({ mustChange: true, disabledAt: null, disabledBy: null, lastSignInAt: null, passwordSetAt: new Date() });
    this.passwordSignInAttempt.defaults = () => ({ failedCount: 0, lastFailedAt: null, lockedUntil: null });
    this.appUser.defaults = () => ({ name: null, firstSignInAt: null, addedBy: null, createdAt: new Date() });
  }

  /** Mirrors SignInRateLimit.HIT_SQL / SWEEP_SQL semantics. */
  $queryRawUnsafe = async (sql: string, ...params: unknown[]): Promise<Array<{ count: number }>> => {
    if (sql.startsWith("DELETE")) return [];
    const [key, now, cutoff] = params as [string, Date, Date];
    const row = this.rateLimit.get(key);
    const next = !row || row.windowStart <= cutoff ? { windowStart: now, count: 1 } : { windowStart: row.windowStart, count: row.count + 1 };
    this.rateLimit.set(key, next);
    return [{ count: next.count }];
  };

  /** Runs the callback on a snapshot; any throw (or a returned ok:false) keeps the old state only on throw, like Postgres. */
  $transaction = async <T>(fn: (tx: this) => Promise<T>): Promise<T> => {
    const tables = [this.appUser, this.serviceLineAccessGrant, this.serviceLineAccessHistory, this.passwordCredential, this.passwordCredentialHistory, this.passwordSignInAttempt];
    const snap = tables.map((t) => new Map(t.rows));
    try {
      return await fn(this);
    } catch (e) {
      tables.forEach((t, i) => (t.rows = snap[i]));
      throw e;
    }
  };
}
