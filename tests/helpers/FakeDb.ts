import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";

type Row = Record<string, unknown>;

interface State {
  projects: Row[];
  history: Row[];
  snapshots: Row[];
  recipients: Row[];
  viewSettings: Row[];
  viewSettingsHistory: Row[];
  artifacts: Row[];
  deliveries: Row[];
  reportOptions: Row[];
  reportOptionsHistory: Row[];
  serviceLineSettings: Row[];
  serviceLineSettingsHistory: Row[];
  milestones: Row[];
  templates: Row[];
  templateItems: Row[];
  templateHistory: Row[];
}

/**
 * Minimal in-memory stand-in for the Prisma calls used by the services.
 * $transaction snapshots state and rolls back on throw; every write records whether it
 * happened inside a transaction so tests can assert atomicity.
 */
export class FakeDb {
  state: State = {
    projects: [],
    history: [],
    snapshots: [],
    recipients: [],
    viewSettings: [],
    viewSettingsHistory: [],
    artifacts: [],
    deliveries: [],
    reportOptions: [],
    reportOptionsHistory: [],
    serviceLineSettings: [],
    serviceLineSettingsHistory: [],
    milestones: [],
    templates: [],
    templateItems: [],
    templateHistory: [],
  };
  writes: { model: string; op: string; inTx: boolean; txId: number | null }[] = [];
  /** Simulate a database without migration 0015 (project_milestones missing). */
  missingMilestoneTable = false;
  transactions = 0;
  private txCounter = 0;
  private txQueue: Promise<unknown> = Promise.resolve();

  static clone(state: State): State {
    const c = (rows: Row[]) => rows.map((r) => ({ ...r }));
    return {
      projects: c(state.projects),
      history: c(state.history),
      snapshots: c(state.snapshots),
      recipients: c(state.recipients),
      viewSettings: c(state.viewSettings),
      viewSettingsHistory: c(state.viewSettingsHistory),
      artifacts: c(state.artifacts),
      deliveries: c(state.deliveries),
      reportOptions: c(state.reportOptions),
      reportOptionsHistory: c(state.reportOptionsHistory),
      serviceLineSettings: c(state.serviceLineSettings),
      serviceLineSettingsHistory: c(state.serviceLineSettingsHistory),
      milestones: c(state.milestones),
      templates: c(state.templates),
      templateItems: c(state.templateItems),
      templateHistory: c(state.templateHistory),
    };
  }

  asClient(): PrismaClient {
    return this.api(null) as unknown as PrismaClient;
  }

  private api(txId: number | null) {
    const rec = (model: string, op: string) => this.writes.push({ model, op, inTx: txId !== null, txId });
    const matches = (row: Row, where: Row = {}): boolean =>
      Object.entries(where).every(([k, v]) => {
        if (v && typeof v === "object" && !(v instanceof Date)) {
          const cond = v as { in?: unknown[]; notIn?: unknown[]; gt?: Date };
          if (cond.in) return cond.in.includes(row[k]);
          if (cond.notIn) return !cond.notIn.includes(row[k]);
          if (cond.gt) return (row[k] as Date).getTime() > cond.gt.getTime();
        }
        if (v instanceof Date) return row[k] instanceof Date && (row[k] as Date).getTime() === v.getTime();
        return row[k] === v;
      });
    const uniqueViolation = () => Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    const sortBy = (rows: Row[], orderBy?: Record<string, "asc" | "desc">) => {
      if (!orderBy) return rows;
      const [[key, dir]] = Object.entries(orderBy);
      return [...rows].sort((a, b) => {
        const x = a[key] instanceof Date ? (a[key] as Date).getTime() : (a[key] as number);
        const y = b[key] instanceof Date ? (b[key] as Date).getTime() : (b[key] as number);
        return dir === "desc" ? y - x : x - y;
      });
    };
    const pick = (row: Row, select?: Record<string, boolean>) =>
      select ? Object.fromEntries(Object.keys(select).map((k) => [k, row[k]])) : { ...row };

    return {
      // Transactions run one at a time (like SERIALIZABLE without retries), so a rollback never
      // discards another transaction's committed writes.
      $transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
        const run = async () => {
          this.transactions += 1;
          const id = ++this.txCounter;
          const backup = FakeDb.clone(this.state);
          try {
            return await fn(this.api(id));
          } catch (e) {
            this.state = backup;
            throw e;
          }
        };
        const result = this.txQueue.then(run, run);
        this.txQueue = result.catch(() => undefined);
        return result;
      },
      project: {
        create: async ({ data }: { data: Row }) => {
          rec("project", "create");
          const now = new Date();
          const row = {
            id: randomUUID(),
            description: null,
            inforRequestNumber: null,
            physicianChampion: null,
            physicianChampionEmail: null,
            requesterNotApplicable: false,
            contractsLead: null,
            nextMilestone: null,
            dueDate: null,
            targetCompletion: null,
            percentComplete: null,
            note: null,
            accomplishment: null,
            completedOn: null,
            completionReportedAt: null,
            includeInReport: true,
            archivedAt: null,
            deletedBy: null,
            hiddenFromDashboard: false,
            hiddenFromReport: false,
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
        findFirst: async ({ where, select, orderBy }: { where?: Row; select?: Record<string, boolean>; orderBy?: Record<string, "asc" | "desc"> } = {}) => {
          const rows = sortBy(
            this.state.snapshots.filter((s) => matches(s, where)),
            orderBy ?? { generatedAt: "desc" },
          );
          return rows[0] ? pick(rows[0], select) : null;
        },
        findMany: async ({ where, select, orderBy }: { where?: Row; select?: Record<string, boolean>; orderBy?: Record<string, "asc" | "desc"> } = {}) =>
          sortBy(this.state.snapshots.filter((s) => matches(s, where)), orderBy).map((s) => pick(s, select)),
        create: async ({ data }: { data: Row }) => {
          rec("reportSnapshot", "create");
          const clash = this.state.snapshots.some(
            (s) =>
              (s.periodStart as Date).getTime() === (data.periodStart as Date).getTime() &&
              (s.periodEnd as Date).getTime() === (data.periodEnd as Date).getTime(),
          );
          if (clash) throw uniqueViolation();
          const row = { id: randomUUID(), pdfStorageKey: null, sentAt: null, sentToJson: null, deliveryJson: null, ...data };
          this.state.snapshots.push(row);
          return { ...row };
        },
        update: async ({ where, data }: { where: { id: string }; data: Row }) => {
          rec("reportSnapshot", "update");
          const r = this.state.snapshots.find((s) => s.id === where.id)!;
          if (r.pdfStorageKey && "pdfStorageKey" in data && data.pdfStorageKey !== r.pdfStorageKey) {
            throw new Error("ReportSnapshot delivery fields are write-once");
          }
          Object.assign(r, data);
          return { ...r };
        },
      },
      reportArtifact: {
        findFirst: async ({ where }: { where?: Row } = {}) => {
          const r = this.state.artifacts.find((a) => matches(a, where));
          return r ? { ...r } : null;
        },
        create: async ({ data }: { data: Row }) => {
          rec("reportArtifact", "create");
          if (this.state.artifacts.some((a) => a.snapshotId === data.snapshotId && a.kind === data.kind)) throw uniqueViolation();
          const row = { id: randomUUID(), createdAt: new Date(), ...data };
          this.state.artifacts.push(row);
          return { ...row };
        },
      },
      reportOptions: {
        findUnique: async ({ where }: { where: { id: string } }) => {
          const r = this.state.reportOptions.find((o) => o.id === where.id);
          return r ? { ...r } : null;
        },
        upsert: async ({ where, create, update }: { where: { id: string }; create: Row; update: Row }) => {
          rec("reportOptions", "upsert");
          const r = this.state.reportOptions.find((o) => o.id === where.id);
          if (r) {
            Object.assign(r, update, { updatedAt: new Date() });
            return { ...r };
          }
          const row = { ...create, updatedAt: new Date() };
          this.state.reportOptions.push(row);
          return { ...row };
        },
      },
      reportOptionsHistory: {
        create: async ({ data }: { data: Row }) => {
          rec("reportOptionsHistory", "create");
          const row = { id: randomUUID(), changedAt: new Date(), ...data };
          this.state.reportOptionsHistory.push(row);
          return { ...row };
        },
      },
      serviceLineSettings: {
        findUnique: async ({ where }: { where: { id: string } }) => {
          const r = this.state.serviceLineSettings.find((o) => o.id === where.id);
          return r ? { ...r } : null;
        },
        upsert: async ({ where, create, update }: { where: { id: string }; create: Row; update: Row }) => {
          rec("serviceLineSettings", "upsert");
          const r = this.state.serviceLineSettings.find((o) => o.id === where.id);
          if (r) {
            Object.assign(r, update, { updatedAt: new Date() });
            return { ...r };
          }
          const row = { ...create, updatedAt: new Date() };
          this.state.serviceLineSettings.push(row);
          return { ...row };
        },
      },
      serviceLineSettingsHistory: {
        create: async ({ data }: { data: Row }) => {
          rec("serviceLineSettingsHistory", "create");
          const row = { id: randomUUID(), changedAt: new Date(), ...data };
          this.state.serviceLineSettingsHistory.push(row);
          return { ...row };
        },
        findMany: async ({ take }: { orderBy?: unknown; take?: number } = {}) =>
          [...this.state.serviceLineSettingsHistory]
            .sort((a, b) => (b.changedAt as Date).getTime() - (a.changedAt as Date).getTime())
            .slice(0, take ?? undefined)
            .map((r) => ({ ...r })),
      },
      projectMilestone: {
        findMany: async ({ where }: { where?: Row } = {}) => {
          if (this.missingMilestoneTable) throw Object.assign(new Error("The table `project_milestones` does not exist"), { code: "P2021" });
          return this.state.milestones.filter((m) => matches(m, where)).map((m) => ({ ...m }));
        },
        create: async ({ data }: { data: Row }) => {
          rec("projectMilestone", "create");
          if (!this.state.projects.some((p) => p.id === data.projectId)) throw new Error("FK project_milestones_projectId_fkey");
          const now = new Date();
          const row = { id: randomUUID(), done: false, doneAt: null, dueDate: null, sourceTemplateId: null, createdAt: now, updatedAt: now, ...data };
          this.state.milestones.push(row);
          return { ...row };
        },
        update: async ({ where, data }: { where: { id: string }; data: Row }) => {
          rec("projectMilestone", "update");
          const r = this.state.milestones.find((m) => m.id === where.id);
          if (!r) throw new Error("not found");
          Object.assign(r, data, { updatedAt: new Date() });
          return { ...r };
        },
        delete: async ({ where }: { where: { id: string } }) => {
          rec("projectMilestone", "delete");
          const i = this.state.milestones.findIndex((m) => m.id === where.id);
          if (i < 0) throw new Error("not found");
          const [r] = this.state.milestones.splice(i, 1);
          return { ...r };
        },
      },
      milestoneTemplate: {
        findMany: async ({ where, select }: { where?: Row; select?: Record<string, boolean> } = {}) =>
          this.state.templates.filter((t) => matches(t, where)).map((t) => pick(t, select)),
        findUnique: async ({ where }: { where: { id: string } }) => {
          const r = this.state.templates.find((t) => t.id === where.id);
          return r ? { ...r } : null;
        },
        create: async ({ data }: { data: Row }) => {
          rec("milestoneTemplate", "create");
          const now = new Date();
          const row = { id: randomUUID(), createdAt: now, updatedAt: now, ...data };
          this.state.templates.push(row);
          return { ...row };
        },
        update: async ({ where, data }: { where: { id: string }; data: Row }) => {
          rec("milestoneTemplate", "update");
          const r = this.state.templates.find((t) => t.id === where.id);
          if (!r) throw new Error("not found");
          Object.assign(r, data, { updatedAt: new Date() });
          return { ...r };
        },
        delete: async ({ where }: { where: { id: string } }) => {
          rec("milestoneTemplate", "delete");
          const i = this.state.templates.findIndex((t) => t.id === where.id);
          if (i < 0) throw new Error("not found");
          const [r] = this.state.templates.splice(i, 1);
          // ON DELETE CASCADE (items) and SET NULL (project steps), as in migration 0015.
          this.state.templateItems = this.state.templateItems.filter((it) => it.templateId !== r.id);
          for (const m of this.state.milestones) if (m.sourceTemplateId === r.id) m.sourceTemplateId = null;
          return { ...r };
        },
      },
      milestoneTemplateItem: {
        findMany: async ({ where }: { where?: Row } = {}) => this.state.templateItems.filter((t) => matches(t, where)).map((t) => ({ ...t })),
        findUnique: async ({ where }: { where: { id: string } }) => {
          const r = this.state.templateItems.find((t) => t.id === where.id);
          return r ? { ...r } : null;
        },
        create: async ({ data }: { data: Row }) => {
          rec("milestoneTemplateItem", "create");
          const now = new Date();
          const row = { id: randomUUID(), createdAt: now, updatedAt: now, ...data };
          this.state.templateItems.push(row);
          return { ...row };
        },
        update: async ({ where, data }: { where: { id: string }; data: Row }) => {
          rec("milestoneTemplateItem", "update");
          const r = this.state.templateItems.find((t) => t.id === where.id);
          if (!r) throw new Error("not found");
          Object.assign(r, data, { updatedAt: new Date() });
          return { ...r };
        },
        delete: async ({ where }: { where: { id: string } }) => {
          rec("milestoneTemplateItem", "delete");
          const i = this.state.templateItems.findIndex((t) => t.id === where.id);
          if (i < 0) throw new Error("not found");
          const [r] = this.state.templateItems.splice(i, 1);
          return { ...r };
        },
      },
      milestoneTemplateHistory: {
        create: async ({ data }: { data: Row }) => {
          rec("milestoneTemplateHistory", "create");
          const row = { id: randomUUID(), changedAt: new Date(), oldValue: null, newValue: null, ...data };
          this.state.templateHistory.push(row);
          return { ...row };
        },
        findMany: async ({ take }: { orderBy?: unknown; take?: number } = {}) =>
          [...this.state.templateHistory]
            .sort((a, b) => (b.changedAt as Date).getTime() - (a.changedAt as Date).getTime())
            .slice(0, take ?? undefined)
            .map((r) => ({ ...r })),
      },
      reportDelivery: {
        create: async ({ data }: { data: Row }) => {
          rec("reportDelivery", "create");
          const row = { id: randomUUID(), attemptedAt: new Date(), ...data };
          this.state.deliveries.push(row);
          return { ...row };
        },
        findMany: async ({ where }: { where?: Row } = {}) =>
          this.state.deliveries.filter((d) => matches(d, where)).map((d) => ({ ...d })),
      },
      viewSettings: {
        findUnique: async ({ where }: { where: { context: string } }) => {
          const r = this.state.viewSettings.find((v) => v.context === where.context);
          return r ? { ...r } : null;
        },
        upsert: async ({ where, create, update }: { where: { context: string }; create: Row; update: Row }) => {
          rec("viewSettings", "upsert");
          const r = this.state.viewSettings.find((v) => v.context === where.context);
          if (r) {
            Object.assign(r, update, { updatedAt: new Date() });
            return { ...r };
          }
          const row = { ...create, updatedAt: new Date() };
          this.state.viewSettings.push(row);
          return { ...row };
        },
      },
      viewSettingsHistory: {
        create: async ({ data }: { data: Row }) => {
          rec("viewSettingsHistory", "create");
          const row = { id: randomUUID(), changedAt: new Date(), ...data };
          this.state.viewSettingsHistory.push(row);
          return { ...row };
        },
        findMany: async ({ where }: { where?: Row } = {}) =>
          this.state.viewSettingsHistory.filter((h) => matches(h, where)).map((h) => ({ ...h })),
      },
      recipient: {
        findMany: async ({ where }: { where?: Row } = {}) =>
          this.state.recipients.filter((r) => matches(r, where)).map((r) => ({ ...r })),
      },
    };
  }
}
