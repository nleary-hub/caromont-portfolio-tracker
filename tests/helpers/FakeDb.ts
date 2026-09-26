import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";

type Row = Record<string, unknown>;

interface State {
  projects: Row[];
  history: Row[];
  snapshots: Row[];
  recipients: Row[];
}

/**
 * Minimal in-memory stand-in for the Prisma calls used by the services.
 * $transaction snapshots state and rolls back on throw; every write records whether it
 * happened inside a transaction so tests can assert atomicity.
 */
export class FakeDb {
  state: State = { projects: [], history: [], snapshots: [], recipients: [] };
  writes: { model: string; op: string; inTx: boolean; txId: number | null }[] = [];
  transactions = 0;
  private txCounter = 0;

  static clone(state: State): State {
    const c = (rows: Row[]) => rows.map((r) => ({ ...r }));
    return { projects: c(state.projects), history: c(state.history), snapshots: c(state.snapshots), recipients: c(state.recipients) };
  }

  asClient(): PrismaClient {
    return this.api(null) as unknown as PrismaClient;
  }

  private api(txId: number | null) {
    const rec = (model: string, op: string) => this.writes.push({ model, op, inTx: txId !== null, txId });
    const matches = (row: Row, where: Row = {}): boolean =>
      Object.entries(where).every(([k, v]) => {
        if (v && typeof v === "object" && !(v instanceof Date)) {
          const cond = v as { in?: unknown[]; gt?: Date };
          if (cond.in) return cond.in.includes(row[k]);
          if (cond.gt) return (row[k] as Date).getTime() > cond.gt.getTime();
        }
        return row[k] === v;
      });
    const pick = (row: Row, select?: Record<string, boolean>) =>
      select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k]])) : { ...row };

    return {
      $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
        this.transactions += 1;
        const id = ++this.txCounter;
        const backup = FakeDb.clone(this.state);
        try {
          return await fn(this.api(id));
        } catch (e) {
          this.state = backup;
          throw e;
        }
      },
      project: {
        create: async ({ data }: { data: Row }) => {
          rec("project", "create");
          const now = new Date();
          const row = {
            id: randomUUID(),
            physicianChampion: null,
            physicianChampionEmail: null,
            nextMilestone: null,
            dueDate: null,
            targetCompletion: null,
            percentComplete: null,
            note: null,
            includeInReport: true,
            archivedAt: null,
            closedReportedAt: null,
            createdAt: now,
            updatedAt: now,
            ...data,
          };
          this.state.projects.push(row);
          return { ...row };
        },
        findUnique: async ({ where }: { where: { id: string } }) => {
          const r = this.state.projects.find((p) => p.id === where.id);
          return r ? { ...r } : null;
        },
        findMany: async ({ where }: { where?: Row } = {}) =>
          this.state.projects.filter((p) => matches(p, where)).map((p) => ({ ...p })),
        update: async ({ where, data }: { where: { id: string }; data: Row }) => {
          rec("project", "update");
          const r = this.state.projects.find((p) => p.id === where.id);
          if (!r) throw new Error("not found");
          Object.assign(r, data, { updatedAt: new Date() });
          return { ...r };
        },
      },
      projectHistory: {
        create: async ({ data }: { data: Row }) => {
          rec("projectHistory", "create");
          const row = { id: randomUUID(), changedAt: new Date(), comment: null, ...data };
          this.state.history.push(row);
          return { ...row };
        },
        createMany: async ({ data }: { data: Row[] }) => {
          rec("projectHistory", "createMany");
          for (const d of data) this.state.history.push({ id: randomUUID(), changedAt: new Date(), comment: null, ...d });
          return { count: data.length };
        },
        findMany: async ({ where, select, distinct }: { where?: Row; select?: Record<string, boolean>; distinct?: string[] } = {}) => {
          let rows = this.state.history.filter((h) => matches(h, where));
          if (distinct?.length) {
            const seen = new Set<string>();
            rows = rows.filter((r) => {
              const k = distinct.map((d) => String(r[d])).join("|");
              if (seen.has(k)) return false;
              seen.add(k);
              return true;
            });
          }
          return rows.map((r) => pick(r, select));
        },
      },
      reportSnapshot: {
        findFirst: async ({ select }: { select?: Record<string, boolean> } = {}) => {
          const sorted = [...this.state.snapshots].sort(
            (a, b) => (b.generatedAt as Date).getTime() - (a.generatedAt as Date).getTime(),
          );
          return sorted[0] ? pick(sorted[0], select) : null;
        },
        create: async ({ data }: { data: Row }) => {
          rec("reportSnapshot", "create");
          const row = { id: randomUUID(), pdfStorageKey: null, sentAt: null, sentToJson: null, ...data };
          this.state.snapshots.push(row);
          return { ...row };
        },
        update: async ({ where, data }: { where: { id: string }; data: Row }) => {
          rec("reportSnapshot", "update");
          const r = this.state.snapshots.find((s) => s.id === where.id)!;
          Object.assign(r, data);
          return { ...r };
        },
      },
      recipient: {
        findMany: async ({ where }: { where?: Row } = {}) =>
          this.state.recipients.filter((r) => matches(r, where)).map((r) => ({ ...r })),
      },
    };
  }
}
