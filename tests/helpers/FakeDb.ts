import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import { ServiceLine } from "@/lib/domain/ServiceLine";
import { ServiceAreaInfo } from "@/lib/domain/ServiceAreaInfo";

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
  serviceLines: Row[];
  serviceLineHistory: Row[];
  serviceLineUserState: Row[];
  lineLayouts: Row[];
  lineLayoutHistory: Row[];
  departments: Row[];
  departmentHistory: Row[];
  yearEndReports: Row[];
  priorInforNumbers: Row[];
  appUsers: Row[];
  accessGrants: Row[];
  accessHistory: Row[];
  deptAccess: Row[];
  deptAccessHistory: Row[];
}

/** Scoped tables: a row stored without serviceLineId (tests that push rows directly) belongs to the default line. */
const SCOPED_DEFAULT = ServiceLine.DEFAULT_ID;

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
    // Migration 0016 seeds the default line (CVPSL).
    serviceLines: [FakeDb.defaultLineRow()],
    serviceLineHistory: [],
    serviceLineUserState: [],
    lineLayouts: [],
    lineLayoutHistory: [],
    // Migration 0018 seeds the default line's seven departments. Here their ids are the old ServiceArea values, so
    // rows pushed with serviceArea "Cath" belong to them (the real ids are ServiceAreaInfo.CVPSL_IDS).
    departments: FakeDb.defaultDepartmentRows(),
    appUsers: [],
    accessGrants: [],
    accessHistory: [],
    deptAccess: [],
    deptAccessHistory: [],
    departmentHistory: [],
    yearEndReports: [],
    priorInforNumbers: [],
  };
  writes: { model: string; op: string; inTx: boolean; txId: number | null }[] = [];
  /** Simulate a database without migration 0015 (project_milestones missing). */
  missingMilestoneTable = false;
  transactions = 0;
  private txCounter = 0;
  private txQueue: Promise<unknown> = Promise.resolve();

  static defaultLineRow(): Row {
    const s = ServiceLine.defaultScope();
    const at = new Date("2026-09-26T00:00:00Z");
    return {
      id: s.id,
      name: s.name,
      shortName: s.shortName,
      isDefault: true,
      departments: s.departments.map((d) => d.id),
      contractsLeads: [...s.contractsLeads],
      owners: [...s.owners],
      requesters: [...s.requesters],
      archivedAt: null,
      deletedAt: null,
      deletedBy: null,
      createdAt: at,
      updatedAt: at,
      updatedBy: "migration 0016",
    };
  }

  static defaultDepartmentRows(): Row[] {
    const at = new Date("2026-09-26T00:00:00Z");
    return ServiceAreaInfo.LEGACY.map((d, i) => FakeDb.departmentRow(SCOPED_DEFAULT, { id: d.id, name: d.name, shortName: d.shortName, legacyKey: d.id, position: i + 1, createdAt: at, updatedAt: at, updatedBy: "migration 0018" }));
  }

  static departmentRow(serviceLineId: string, over: Row): Row {
    const at = new Date();
    return { id: randomUUID(), serviceLineId, legacyKey: null, archivedAt: null, deletedAt: null, deletedBy: null, createdAt: at, updatedAt: at, updatedBy: "admin@example.org", ...over };
  }

  /** Add a department to a line (tests); goes to the bottom of the line's order unless `position` is given. */
  addDepartment(serviceLineId: string, over: Row = {}): Row {
    const last = this.state.departments.filter((d) => d.serviceLineId === serviceLineId).reduce((m, d) => Math.max(m, d.position as number), 0);
    const row = FakeDb.departmentRow(serviceLineId, { position: last + 1, ...over });
    this.state.departments.push(row);
    return row;
  }

  /** Give a person access to service lines (tests); records the person too. */
  grant(email: string, ...serviceLineIds: string[]): void {
    const e = email.trim().toLowerCase();
    if (!this.state.appUsers.some((u) => u.email === e)) this.state.appUsers.push({ email: e, name: null, firstSignInAt: null, addedBy: null, createdAt: new Date() });
    for (const id of serviceLineIds) {
      if (!this.state.accessGrants.some((g) => g.email === e && g.serviceLineId === id)) this.state.accessGrants.push({ email: e, serviceLineId: id, grantedAt: new Date(), grantedBy: "test" });
    }
  }

  /** Limit a person's line to some departments ("All departments" off; tests). The line must be granted first. */
  limit(email: string, serviceLineId: string, ...departmentIds: string[]): void {
    const e = email.trim().toLowerCase();
    const g = this.state.accessGrants.find((x) => x.email === e && x.serviceLineId === serviceLineId);
    if (!g) throw new Error("grant the line first");
    g.allDepartments = false;
    this.state.deptAccess = this.state.deptAccess.filter((d) => !(d.email === e && d.serviceLineId === serviceLineId));
    for (const id of departmentIds) this.state.deptAccess.push({ email: e, serviceLineId, departmentId: id, grantedAt: new Date(), grantedBy: "test" });
  }

  /** Add an open service line (tests). */
  addLine(overrides: Row = {}): Row {
    const at = new Date();
    const row = {
      id: randomUUID(),
      name: "Oncology Service Line",
      shortName: "ONC",
      isDefault: false,
      departments: [],
      contractsLeads: [],
      owners: [],
      requesters: [],
      archivedAt: null,
      deletedAt: null,
      deletedBy: null,
      createdAt: at,
      updatedAt: at,
      updatedBy: "admin@example.org",
      ...overrides,
    };
    this.state.serviceLines.push(row);
    return row;
  }

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
      serviceLines: c(state.serviceLines),
      serviceLineHistory: c(state.serviceLineHistory),
      serviceLineUserState: c(state.serviceLineUserState),
      lineLayouts: c(state.lineLayouts),
      lineLayoutHistory: c(state.lineLayoutHistory),
      departments: c(state.departments),
      departmentHistory: c(state.departmentHistory),
      yearEndReports: c(state.yearEndReports),
      priorInforNumbers: c(state.priorInforNumbers),
      appUsers: c(state.appUsers),
      accessGrants: c(state.accessGrants),
      accessHistory: c(state.accessHistory),
      deptAccess: c(state.deptAccess),
      deptAccessHistory: c(state.deptAccessHistory),
    };
  }

  asClient(): PrismaClient {
    return this.api(null) as unknown as PrismaClient;
  }

  private api(txId: number | null) {
    const rec = (model: string, op: string) => this.writes.push({ model, op, inTx: txId !== null, txId });
    const value = (row: Row, k: string) => {
      if (k === "serviceLineId" && row[k] === undefined) return SCOPED_DEFAULT;
      if (k === "departmentId" && row[k] === undefined) return row.serviceArea ?? null;
      return row[k];
    };
    const matches = (row: Row, where: Row = {}): boolean =>
      Object.entries(where).every(([k, v]) => {
        if (k === "OR") return (v as Row[]).some((w) => matches(row, w));
        const rv = value(row, k);
        if (v && typeof v === "object" && !(v instanceof Date)) {
          const cond = v as { in?: unknown[]; notIn?: unknown[]; gt?: Date; not?: unknown };
          if (cond.in) return cond.in.includes(rv);
          if (cond.notIn) return !cond.notIn.includes(rv);
          if (cond.gt) return (rv as Date).getTime() > cond.gt.getTime();
          if ("not" in cond) return cond.not === null ? rv !== null && rv !== undefined : rv !== cond.not;
        }
        if (v instanceof Date) return rv instanceof Date && (rv as Date).getTime() === v.getTime();
        if (v === null) return rv === null || rv === undefined;
        return rv === v;
      });
    // Migration 0018: Project.departmentId mirrors serviceArea here (the default scope's departments are keyed by
    // their old values, so the two are equal); the real database keeps them in step with a trigger.
    const withDept = (row: Row): Row => ("serviceArea" in row && !("departmentId" in row) ? { ...row, departmentId: row.serviceArea ?? null } : row);
    const withLine = (row: Row): Row => withDept(row.serviceLineId === undefined ? { ...row, serviceLineId: SCOPED_DEFAULT } : { ...row });
    const syncDept = (data: Row): Row => {
      if (!("departmentId" in data)) return data;
      const { departmentId, ...rest } = data;
      return { ...rest, serviceArea: departmentId ?? null };
    };
    const uniqueViolation = () => Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    const sortBy = (rows: Row[], orderBy?: Record<string, "asc" | "desc"> | Record<string, "asc" | "desc">[]) => {
      if (!orderBy) return rows;
      const keys = (Array.isArray(orderBy) ? orderBy : [orderBy]).flatMap((o) => Object.entries(o));
      const num = (v: unknown) => (v instanceof Date ? v.getTime() : (v as number));
      return [...rows].sort((a, b) => {
        for (const [key, dir] of keys) {
          const d = dir === "desc" ? num(b[key]) - num(a[key]) : num(a[key]) - num(b[key]);
          if (d) return d;
        }
        return 0;
      });
    };
    type Include = { departmentRows?: unknown };
    // A line with no department rows reads without them, so ServiceLineAccess.toScope falls back to its legacy
    // `departments` list (tests that add a line with departments: ["Cath"] keep the old keys).
    const withDepartments = (line: Row, include?: Include): Row => {
      const rows = this.state.departments.filter((d) => d.serviceLineId === line.id);
      if (!include?.departmentRows || rows.length === 0) return { ...line };
      return { ...line, departmentRows: sortBy(rows, [{ position: "asc" }, { createdAt: "asc" }]).map((d) => ({ ...d })) };
    };
    const deptUnique = (row: Row) => {
      const clash = this.state.departments.some(
        (d) =>
          d.id !== row.id &&
          d.serviceLineId === row.serviceLineId &&
          !d.deletedAt &&
          !row.deletedAt &&
          (String(d.name).toLowerCase() === String(row.name).toLowerCase() || String(d.shortName).toLowerCase() === String(row.shortName).toLowerCase()),
      );
      if (clash) throw uniqueViolation();
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
            ...syncDept(data),
          };
          this.state.projects.push(row);
          return withDept({ ...row });
        },
        findUnique: async ({ where }: { where: { id: string } }) => {
          const r = this.state.projects.find((p) => p.id === where.id);
          return r ? withLine(r) : null;
        },
        findFirst: async ({ where, select }: { where?: Row; select?: Record<string, boolean> } = {}) => {
          const r = this.state.projects.find((p) => matches(p, where));
          return r ? pick(withLine(r), select) : null;
        },
        findMany: async ({ where, select }: { where?: Row; select?: Record<string, boolean> } = {}) =>
          this.state.projects.filter((p) => matches(p, where)).map((p) => pick(withLine(p), select)),
        update: async ({ where, data }: { where: { id: string }; data: Row }) => {
          rec("project", "update");
          const r = this.state.projects.find((p) => p.id === where.id);
          if (!r) throw new Error("not found");
          Object.assign(r, syncDept(data), { updatedAt: new Date() });
          return withDept({ ...r });
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
        /** groupBy({ by: ["projectId"], where, _max: { changedAt: true } }): the dashboard's "Updated <date>". */
        groupBy: async ({ by, where }: { by: string[]; where?: Row; _max?: Record<string, boolean> }) => {
          const groups = new Map<string, Row>();
          for (const h of this.state.history.filter((x) => matches(x, where))) {
            const k = by.map((b) => String(h[b])).join("|");
            const g = groups.get(k) ?? { ...Object.fromEntries(by.map((b) => [b, h[b]])), _max: { changedAt: null } };
            const cur = (g._max as { changedAt: Date | null }).changedAt;
            if (!cur || (h.changedAt as Date) > cur) (g._max as { changedAt: Date | null }).changedAt = h.changedAt as Date;
            groups.set(k, g);
          }
          return [...groups.values()];
        },
      },
      reportSnapshot: {
        findFirst: async ({ where, select, orderBy }: { where?: Row; select?: Record<string, boolean>; orderBy?: Record<string, "asc" | "desc"> } = {}) => {
          const rows = sortBy(
            this.state.snapshots.filter((s) => matches(s, where)),
            orderBy ?? { generatedAt: "desc" },
          );
          return rows[0] ? pick(withLine(rows[0]), select) : null;
        },
        findMany: async ({ where, select, orderBy }: { where?: Row; select?: Record<string, boolean>; orderBy?: Record<string, "asc" | "desc"> } = {}) =>
          sortBy(this.state.snapshots.filter((s) => matches(s, where)), orderBy).map((s) => pick(withLine(s), select)),
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
      // Migration 0019: append-only (create and reads only).
      yearEndReport: {
        create: async ({ data }: { data: Row }) => {
          rec("yearEndReport", "create");
          const row = { id: randomUUID(), ...data };
          this.state.yearEndReports.push(row);
          return { ...row };
        },
        findMany: async ({ where, select, orderBy }: { where?: Row; select?: Record<string, boolean>; orderBy?: Record<string, "asc" | "desc"> } = {}) =>
          sortBy(this.state.yearEndReports.filter((r) => matches(r, where)), orderBy).map((r) => pick(r, select)),
        findFirst: async ({ where }: { where?: Row } = {}) => {
          const r = this.state.yearEndReports.find((x) => matches(x, where));
          return r ? { ...r } : null;
        },
      },
      // Migration 0021: append-only (create and reads only).
      projectPriorInforNumber: {
        create: async ({ data }: { data: Row }) => {
          rec("projectPriorInforNumber", "create");
          const row = { id: randomUUID(), recordedAt: null, createdAt: new Date(), ...data };
          this.state.priorInforNumbers.push(row);
          return { ...row };
        },
        findMany: async ({ where, select, orderBy }: { where?: Row; select?: Record<string, boolean>; orderBy?: Record<string, "asc" | "desc"> } = {}) =>
          sortBy(this.state.priorInforNumbers.filter((r) => matches(r, where)), orderBy).map((r) => pick(r, select)),
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
      lineLayout: {
        findUnique: async ({ where }: { where: Row }) => {
          const r = this.state.lineLayouts.find((o) => matches(o, where));
          return r ? { ...r } : null;
        },
        upsert: async ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
          rec("lineLayout", "upsert");
          const r = this.state.lineLayouts.find((o) => matches(o, where));
          if (r) {
            Object.assign(r, update, { updatedAt: new Date() });
            return { ...r };
          }
          const row = { columnsJson: null, rowOrderJson: null, ...create, updatedAt: new Date() };
          this.state.lineLayouts.push(row);
          return { ...row };
        },
        update: async ({ where, data }: { where: Row; data: Row }) => {
          rec("lineLayout", "update");
          const r = this.state.lineLayouts.find((o) => matches(o, where));
          if (!r) throw new Error("not found");
          Object.assign(r, data, { updatedAt: new Date() });
          return { ...r };
        },
      },
      lineLayoutHistory: {
        create: async ({ data }: { data: Row }) => {
          rec("lineLayoutHistory", "create");
          const row = { id: randomUUID(), changedAt: new Date(), oldValue: null, newValue: null, ...data };
          this.state.lineLayoutHistory.push(row);
          return { ...row };
        },
        findMany: async ({ where, orderBy, take }: { where?: Row; orderBy?: Record<string, "asc" | "desc">; take?: number } = {}) =>
          sortBy(this.state.lineLayoutHistory.filter((h) => matches(h, where)), orderBy)
            .slice(0, take ?? Number.POSITIVE_INFINITY)
            .map((h) => ({ ...h })),
      },
      reportOptions: {
        findUnique: async ({ where }: { where: Row }) => {
          const r = this.state.reportOptions.find((o) => matches(o, where));
          return r ? { ...r } : null;
        },
        upsert: async ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
          rec("reportOptions", "upsert");
          const r = this.state.reportOptions.find((o) => matches(o, where));
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
        findFirst: async ({ where }: { where?: Row } = {}) => {
          const rows = [...this.state.reportOptionsHistory.filter((h) => matches(h, where))].reverse().sort((a, b) => (b.changedAt as Date).getTime() - (a.changedAt as Date).getTime());
          return rows[0] ? { ...rows[0] } : null;
        },
        create: async ({ data }: { data: Row }) => {
          rec("reportOptionsHistory", "create");
          const row = { id: randomUUID(), changedAt: new Date(), ...data };
          this.state.reportOptionsHistory.push(row);
          return { ...row };
        },
        findMany: async ({ where, orderBy, take }: { where?: Row; orderBy?: Record<string, "asc" | "desc">; take?: number } = {}) =>
          sortBy(this.state.reportOptionsHistory.filter((h) => matches(h, where)), orderBy)
            .slice(0, take ?? Number.POSITIVE_INFINITY)
            .map((h) => ({ ...h })),
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
          const row = { id: randomUUID(), done: false, doneAt: null, doneBy: null, checkedAt: null, dueDate: null, sourceTemplateId: null, createdAt: now, updatedAt: now, ...data };
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
          this.state.templates.filter((t) => matches(t, where)).map((t) => pick(withLine(t), select)),
        findUnique: async ({ where }: { where: { id: string } }) => {
          const r = this.state.templates.find((t) => t.id === where.id);
          return r ? withLine(r) : null;
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
        findMany: async ({ where, take }: { where?: Row; orderBy?: unknown; take?: number } = {}) =>
          [...this.state.templateHistory.filter((h) => matches(h, where))]
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
      department: {
        findUnique: async ({ where }: { where: { id: string } }) => {
          const r = this.state.departments.find((d) => d.id === where.id);
          return r ? { ...r } : null;
        },
        findMany: async ({ where, orderBy, select }: { where?: Row; orderBy?: Record<string, "asc" | "desc"> | Record<string, "asc" | "desc">[]; select?: Record<string, boolean> } = {}) =>
          sortBy(this.state.departments.filter((d) => matches(d, where)), orderBy).map((d) => pick(d, select)),
        create: async ({ data }: { data: Row }) => {
          rec("department", "create");
          const row = FakeDb.departmentRow(String(data.serviceLineId), data);
          deptUnique(row);
          this.state.departments.push(row);
          return { ...row };
        },
        update: async ({ where, data }: { where: { id: string }; data: Row }) => {
          rec("department", "update");
          const r = this.state.departments.find((d) => d.id === where.id);
          if (!r) throw new Error("not found");
          deptUnique({ ...r, ...data });
          Object.assign(r, data, { updatedAt: new Date() });
          return { ...r };
        },
        delete: async () => {
          // department_no_delete trigger (migration 0018): departments are only soft-deleted.
          throw new Error("department rows are never deleted");
        },
      },
      departmentHistory: {
        create: async ({ data }: { data: Row }) => {
          rec("departmentHistory", "create");
          const row = { id: randomUUID(), changedAt: new Date(), departmentId: null, oldValue: null, newValue: null, ...data };
          this.state.departmentHistory.push(row);
          return { ...row };
        },
        findMany: async ({ where, take }: { where?: Row; orderBy?: unknown; take?: number } = {}) =>
          [...this.state.departmentHistory.filter((h) => matches(h, where))]
            .reverse()
            .sort((a, b) => (b.changedAt as Date).getTime() - (a.changedAt as Date).getTime())
            .slice(0, take ?? undefined)
            .map((r) => ({ ...r })),
      },
      serviceLine: {
        findFirst: async ({ where, include }: { where?: Row; include?: Include } = {}) => {
          const r = this.state.serviceLines.find((l) => matches(l, where));
          return r ? withDepartments(r, include) : null;
        },
        findUnique: async ({ where, include }: { where: { id: string }; include?: Include }) => {
          const r = this.state.serviceLines.find((l) => l.id === where.id);
          return r ? withDepartments(r, include) : null;
        },
        findMany: async ({ where, orderBy, include }: { where?: Row; orderBy?: Record<string, "asc" | "desc">; include?: Include } = {}) =>
          sortBy(this.state.serviceLines.filter((l) => matches(l, where)), orderBy).map((l) => withDepartments(l, include)),
        create: async ({ data }: { data: Row }) => {
          rec("serviceLine", "create");
          const now = new Date();
          const row = { id: randomUUID(), isDefault: false, departments: [], contractsLeads: [], owners: [], requesters: [], archivedAt: null, deletedAt: null, deletedBy: null, createdAt: now, updatedAt: now, ...data };
          this.state.serviceLines.push(row);
          return { ...row };
        },
        update: async ({ where, data }: { where: { id: string }; data: Row }) => {
          rec("serviceLine", "update");
          const r = this.state.serviceLines.find((l) => l.id === where.id);
          if (!r) throw new Error("not found");
          // service_line_default_open check (migration 0016).
          if (r.isDefault && ((data.archivedAt ?? null) !== null || (data.deletedAt ?? null) !== null)) throw new Error("service_line_default_open");
          Object.assign(r, data, { updatedAt: new Date() });
          return { ...r };
        },
      },
      serviceLineHistory: {
        create: async ({ data }: { data: Row }) => {
          rec("serviceLineHistory", "create");
          const row = { id: randomUUID(), changedAt: new Date(), oldValue: null, newValue: null, ...data };
          this.state.serviceLineHistory.push(row);
          return { ...row };
        },
        findMany: async ({ where, take }: { where?: Row; orderBy?: unknown; take?: number } = {}) =>
          [...this.state.serviceLineHistory.filter((h) => matches(h, where))]
            .reverse()
            .sort((a, b) => (b.changedAt as Date).getTime() - (a.changedAt as Date).getTime())
            .slice(0, take ?? undefined)
            .map((r) => ({ ...r })),
      },
      serviceLineUserState: {
        findUnique: async ({ where }: { where: { email: string } }) => {
          const r = this.state.serviceLineUserState.find((u) => u.email === where.email);
          return r ? { ...r } : null;
        },
        upsert: async ({ where, create, update }: { where: { email: string }; create: Row; update: Row }) => {
          rec("serviceLineUserState", "upsert");
          const r = this.state.serviceLineUserState.find((u) => u.email === where.email);
          if (r) {
            Object.assign(r, update, { updatedAt: new Date() });
            return { ...r };
          }
          const row = { ...create, updatedAt: new Date() };
          this.state.serviceLineUserState.push(row);
          return { ...row };
        },
      },
      appUser: {
        findUnique: async ({ where }: { where: { email: string } }) => {
          const r = this.state.appUsers.find((u) => u.email === where.email);
          return r ? { ...r } : null;
        },
        findMany: async ({ where, include }: { where?: Row; include?: { access?: boolean | { include?: { departments?: boolean } } } } = {}) =>
          this.state.appUsers
            .filter((u) => matches(u, where))
            .map((u) => ({
              ...u,
              ...(include?.access
                ? {
                    access: this.state.accessGrants
                      .filter((g) => g.email === u.email)
                      .map((g) => ({
                        allDepartments: true,
                        ...g,
                        ...(typeof include.access === "object" && include.access.include?.departments
                          ? { departments: this.state.deptAccess.filter((d) => d.email === g.email && d.serviceLineId === g.serviceLineId).map((d) => ({ ...d })) }
                          : {}),
                      })),
                  }
                : {}),
            })),
        create: async ({ data }: { data: Row }) => {
          rec("appUser", "create");
          if (this.state.appUsers.some((u) => u.email === data.email)) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
          const row = { name: null, firstSignInAt: null, addedBy: null, createdAt: new Date(), ...data };
          this.state.appUsers.push(row);
          return { ...row };
        },
        updateMany: async ({ where, data }: { where?: Row; data: Row }) => {
          rec("appUser", "updateMany");
          const hit = this.state.appUsers.filter((u) => matches(u, where));
          for (const u of hit) Object.assign(u, data);
          return { count: hit.length };
        },
        update: async ({ where, data }: { where: { email: string }; data: Row }) => {
          rec("appUser", "update");
          const r = this.state.appUsers.find((u) => u.email === where.email);
          if (!r) throw new Error("not found");
          Object.assign(r, data);
          return { ...r };
        },
      },
      serviceLineAccessGrant: {
        findMany: async ({ where }: { where?: Row } = {}) => this.state.accessGrants.filter((g) => matches(g, where)).map((g) => ({ ...g })),
        findUnique: async ({ where }: { where: { email_serviceLineId: { email: string; serviceLineId: string } } }) => {
          const k = where.email_serviceLineId;
          const r = this.state.accessGrants.find((g) => g.email === k.email && g.serviceLineId === k.serviceLineId);
          return r ? { allDepartments: true, ...r } : null;
        },
        update: async ({ where, data }: { where: { email_serviceLineId: { email: string; serviceLineId: string } }; data: Row }) => {
          rec("serviceLineAccessGrant", "update");
          const k = where.email_serviceLineId;
          const r = this.state.accessGrants.find((g) => g.email === k.email && g.serviceLineId === k.serviceLineId);
          if (!r) throw new Error("not found");
          Object.assign(r, data);
          return { allDepartments: true, ...r };
        },
        create: async ({ data }: { data: Row }) => {
          rec("serviceLineAccessGrant", "create");
          if (!this.state.appUsers.some((u) => u.email === data.email)) throw new Error("service_line_access_email_fkey");
          if (this.state.accessGrants.some((g) => g.email === data.email && g.serviceLineId === data.serviceLineId)) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
          const row = { grantedAt: new Date(), ...data };
          this.state.accessGrants.push(row);
          return { ...row };
        },
        delete: async ({ where }: { where: { email_serviceLineId: { email: string; serviceLineId: string } } }) => {
          rec("serviceLineAccessGrant", "delete");
          const k = where.email_serviceLineId;
          const i = this.state.accessGrants.findIndex((g) => g.email === k.email && g.serviceLineId === k.serviceLineId);
          if (i < 0) throw new Error("not found");
          const [r] = this.state.accessGrants.splice(i, 1);
          // ON DELETE CASCADE: the line's department rows go with it.
          this.state.deptAccess = this.state.deptAccess.filter((d) => !(d.email === k.email && d.serviceLineId === k.serviceLineId));
          return { ...r };
        },
      },
      departmentAccessGrant: {
        findMany: async ({ where }: { where?: Row } = {}) => this.state.deptAccess.filter((d) => matches(d, where)).map((d) => ({ ...d })),
        findUnique: async ({ where }: { where: { email_departmentId: { email: string; departmentId: string } } }) => {
          const k = where.email_departmentId;
          const r = this.state.deptAccess.find((d) => d.email === k.email && d.departmentId === k.departmentId);
          return r ? { ...r } : null;
        },
        create: async ({ data }: { data: Row }) => {
          rec("departmentAccessGrant", "create");
          const line = this.state.accessGrants.find((g) => g.email === data.email && g.serviceLineId === data.serviceLineId);
          if (!line) throw new Error("department_access_email_serviceLineId_fkey");
          const dept = this.state.departments.find((d) => d.id === data.departmentId);
          if (!dept || (dept.serviceLineId ?? SCOPED_DEFAULT) !== data.serviceLineId) throw new Error("department_access_departmentId_serviceLineId_fkey");
          if (this.state.deptAccess.some((d) => d.email === data.email && d.departmentId === data.departmentId)) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
          const row = { grantedAt: new Date(), ...data };
          this.state.deptAccess.push(row);
          return { ...row };
        },
        createMany: async ({ data }: { data: Row[] }) => {
          rec("departmentAccessGrant", "createMany");
          for (const d of data) this.state.deptAccess.push({ grantedAt: new Date(), ...d });
          return { count: data.length };
        },
        delete: async ({ where }: { where: { email_departmentId: { email: string; departmentId: string } } }) => {
          rec("departmentAccessGrant", "delete");
          const k = where.email_departmentId;
          const i = this.state.deptAccess.findIndex((d) => d.email === k.email && d.departmentId === k.departmentId);
          if (i < 0) throw new Error("not found");
          const [r] = this.state.deptAccess.splice(i, 1);
          return { ...r };
        },
        deleteMany: async ({ where }: { where?: Row } = {}) => {
          rec("departmentAccessGrant", "deleteMany");
          const before = this.state.deptAccess.length;
          this.state.deptAccess = this.state.deptAccess.filter((d) => !matches(d, where));
          return { count: before - this.state.deptAccess.length };
        },
      },
      departmentAccessHistory: {
        findMany: async ({ where, orderBy, take }: { where?: Row; orderBy?: Record<string, "asc" | "desc">; take?: number } = {}) =>
          sortBy(this.state.deptAccessHistory.filter((h) => matches(h, where)).map((h) => ({ ...h })), orderBy).slice(0, take ?? undefined),
        create: async ({ data }: { data: Row }) => {
          rec("departmentAccessHistory", "create");
          const row = { id: randomUUID(), changedAt: new Date(), departmentId: null, detail: null, ...data };
          this.state.deptAccessHistory.push(row);
          return { ...row };
        },
      },
      serviceLineAccessHistory: {
        create: async ({ data }: { data: Row }) => {
          rec("serviceLineAccessHistory", "create");
          const row = { id: randomUUID(), changedAt: new Date(), serviceLineId: null, ...data };
          this.state.accessHistory.push(row);
          return { ...row };
        },
      },
      recipient: {
        findMany: async ({ where }: { where?: Row } = {}) =>
          this.state.recipients.filter((r) => matches(r, where)).map((r) => ({ ...r })),
      },
    };
  }
}
