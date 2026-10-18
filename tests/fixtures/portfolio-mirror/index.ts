import type { ProjectStatus } from "@/generated/prisma/enums";
import { ServiceLine, type ServiceLineScope } from "@/lib/domain/ServiceLine";

/**
 * Fictional 33-project mirror of a cardiovascular service line (Tracker AI overhaul, Apex constraint 1). Same shape and
 * signal patterns as the golden examples in the spec, with every name, person, vendor and number made up. No real
 * project, person or data. TODAY is fixed so every computed signal is reproducible.
 */
export const TODAY = "2026-10-17";
export const NOW = new Date("2026-10-17T14:00:00Z");
export const LINE = ServiceLine.defaultScope().id;

const D = (i: number) => `d0000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
export const P = (i: number) => `70000000-0000-4000-8000-${String(i).padStart(12, "0")}`;

export const DEPARTMENTS = [
  { id: D(1), name: "Cath Lab", shortName: "Cath" },
  { id: D(2), name: "Electrophysiology", shortName: "EP" },
  { id: D(3), name: "Interventional Radiology", shortName: "IR" },
  { id: D(4), name: "Inpatient Unit", shortName: "INU" },
  { id: D(5), name: "Cardiovascular Surgery", shortName: "CVSS" },
  { id: D(6), name: "Cardio Neuro", shortName: "CardioNeuro" },
];

export const PEOPLE = ["Avery Lin", "Jordan Pike", "Morgan Reyes", "Casey Brandt", "Riley Okafor", "Dana Whitfield", "Sam Torres", "Quinn Harlow"];
export const REQUESTERS = ["Dr. Elena Marsh", "Dr. Omar Vance", "Dr. Priya Hale"];
export const CONTRACTS = ["Jordan Pike", "Taylor Quinn"];

export function scope(): ServiceLineScope {
  return { ...ServiceLine.defaultScope(), departments: DEPARTMENTS.map((d) => ({ id: d.id, name: d.name, shortName: d.shortName })), owners: PEOPLE, requesters: REQUESTERS, contractsLeads: CONTRACTS };
}

export interface MirrorStep {
  name: string;
  due: string | null;
  done: boolean;
  owner: string | null;
}

export interface MirrorProject {
  i: number;
  name: string;
  req: number | null;
  dept: number;
  owner: string | null;
  requester: string | null;
  contractsLead: string | null;
  status: ProjectStatus;
  /** When the current status was set (a status history row on that day). */
  statusSince: string;
  steps: MirrorStep[];
  note: string;
  /** Earlier Latest updates, newest first, with the day each was replaced. */
  prior: { replacedOn: string; text: string }[];
  /** Day of the latest public update (the note history row). */
  updatedOn: string;
  /** Status and Changed in the last frozen reports, newest first. */
  reports: { status: ProjectStatus; changed: boolean }[];
  description?: string;
}

const s = (name: string, due: string | null, done = false, owner: string | null = null): MirrorStep => ({ name, due, done, owner });

/** The golden-example twins first (indexes are stable; tests refer to them by index). */
export const GOLDEN = {
  SUPPLY: 1,
  REBATE: 2,
  CONSIGNMENT: 3,
  LUMEN_REBATE: 4,
  DOWNTIME: 5,
  CORTEX_EEG: 6,
  RELOCATE: 7,
  REQ_ONLY: 8,
  SUITE_BUILD: 9,
} as const;

const golden: MirrorProject[] = [
  {
    i: 1, name: "Northwind Stent Supply", req: 5101, dept: 3, owner: "Morgan Reyes", requester: "Dr. Omar Vance", contractsLead: "Jordan Pike", status: "OffTrack", statusSince: "2026-09-20",
    steps: [s("Vendor pricing review", "2026-09-01", true, "Jordan Pike"), s("Supply agreement signed", "2026-10-24", false, "Jordan Pike"), s("Item master build", "2026-11-07", false, "Casey Brandt")],
    note: "Supply agreement still in vendor redlines. Contracts following up weekly.", prior: [{ replacedOn: "2026-10-01", text: "Pricing review done; agreement sent to vendor." }], updatedOn: "2026-10-01",
    reports: [{ status: "OffTrack", changed: false }, { status: "OffTrack", changed: true }],
  },
  {
    i: 2, name: "Northwind Stent Rebate", req: 5102, dept: 3, owner: "Morgan Reyes", requester: null, contractsLead: "Jordan Pike", status: "OnTrack", statusSince: "2026-08-15",
    steps: [s("Rebate terms drafted", "2026-10-30", false, "Jordan Pike")], note: "Waiting on the supply agreement before rebate terms can be set.", prior: [], updatedOn: "2026-10-10",
    reports: [{ status: "OnTrack", changed: true }],
  },
  {
    i: 3, name: "Northwind Stent Consignment", req: null, dept: 3, owner: "Casey Brandt", requester: null, contractsLead: "Jordan Pike", status: "AtRisk", statusSince: "2026-10-05",
    steps: [s("Consignment par levels set", "2026-11-14", false, null)], note: "Pending the supply agreement; par levels drafted.", prior: [], updatedOn: "2026-10-05",
    reports: [{ status: "AtRisk", changed: true }],
  },
  {
    i: 4, name: "Lumen Catheter Rebate", req: 5104, dept: 1, owner: "Avery Lin", requester: null, contractsLead: "Taylor Quinn", status: "AtRisk", statusSince: "2026-09-25",
    steps: [s("Rebate claim filed", "2026-10-09", false, "Taylor Quinn")], note: "Claim form drafted, waiting on volume report.", prior: [{ replacedOn: "2026-09-25", text: "Volume report requested." }], updatedOn: "2026-09-25",
    reports: [{ status: "AtRisk", changed: false }, { status: "AtRisk", changed: true }],
  },
  {
    i: 5, name: "IR Suite B Downtime Plan", req: 5105, dept: 3, owner: "Riley Okafor", requester: null, contractsLead: null, status: "OnTrack", statusSince: "2026-09-01",
    steps: [s("Downtime schedule approved", "2026-10-09", false, "Riley Okafor"), s("Staff notified", "2026-10-20", false, "Riley Okafor")], note: "Schedule drafted; approval meeting pending.", prior: [], updatedOn: "2026-10-02",
    reports: [{ status: "OnTrack", changed: true }],
  },
  {
    i: 6, name: "Cortex EEG Upgrade", req: 5106, dept: 6, owner: "Dana Whitfield", requester: "Dr. Priya Hale", contractsLead: "Taylor Quinn", status: "AtRisk", statusSince: "2026-10-08",
    steps: [s("Vendor redlines returned", "2026-10-16", false, "Taylor Quinn"), s("Install scheduled", "2026-11-20", false, "Dana Whitfield")], note: "Vendor has not returned redlines.", prior: [], updatedOn: "2026-10-08",
    reports: [{ status: "AtRisk", changed: true }],
  },
  {
    i: 7, name: "Relocate APP clinic from IR Suite B", req: null, dept: 3, owner: null, requester: null, contractsLead: null, status: "OffTrack", statusSince: "2026-08-20",
    steps: [s("New space identified", "2026-11-30", false, null)], note: "No change.", prior: [{ replacedOn: "2026-08-20", text: "No change." }], updatedOn: "2026-08-20",
    reports: [{ status: "OffTrack", changed: false }, { status: "OffTrack", changed: false }],
  },
  {
    i: 8, name: "Bedside Telemetry Refresh", req: 5123, dept: 4, owner: "Sam Torres", requester: null, contractsLead: null, status: "OnTrack", statusSince: "2026-07-01",
    steps: [s("Quote approved", "2026-09-30", true, "Sam Torres"), s("Hardware delivered", "2026-11-03", false, "Sam Torres"), s("Go-live", "2026-12-01", false, "Sam Torres")], note: "Quote approved. Hardware on order.", prior: [], updatedOn: "2026-10-12",
    reports: [{ status: "OnTrack", changed: true }],
  },
  {
    i: 9, name: "EP Lab 2 Build-out", req: 5109, dept: 2, owner: "Quinn Harlow", requester: "Dr. Elena Marsh", contractsLead: null, status: "OnTrack", statusSince: "2026-06-01",
    steps: [s("Demolition", "2026-09-01", true, "Quinn Harlow"), s("Drywall", "2026-10-15", false, "Quinn Harlow"), s("Flooring and ceiling", "2026-10-29", false, null), s("Equipment install", "2026-12-01", false, null)],
    note: "Drywall nearly done.", prior: [{ replacedOn: "2026-10-01", text: "Demolition complete." }], updatedOn: "2026-10-14", reports: [{ status: "OnTrack", changed: true }],
  },
];

/** Plain filler projects so the set has 33, spread over departments and statuses (all fictional). */
const STATUSES: ProjectStatus[] = ["OnTrack", "OnTrack", "OnTrack", "NotStarted", "OnHold", "Complete", "AtRisk", "OnTrack"];
const filler: MirrorProject[] = Array.from({ length: 24 }, (_, k) => {
  const i = 10 + k;
  const status = STATUSES[k % STATUSES.length];
  const due = `2026-${String(11 + (k % 2)).padStart(2, "0")}-${String(5 + k).padStart(2, "0")}`;
  return {
    i, name: `Sample workflow ${String.fromCharCode(65 + (k % 26))}${k + 1}`, req: k % 3 === 0 ? 5200 + k : null, dept: 1 + (k % 6), owner: PEOPLE[k % PEOPLE.length], requester: k % 4 === 0 ? REQUESTERS[k % 3] : null, contractsLead: null, status, statusSince: "2026-09-01",
    steps: status === "Complete" ? [s("Closeout", "2026-09-15", true, PEOPLE[k % PEOPLE.length])] : [s("Planning", "2026-09-10", true, PEOPLE[k % PEOPLE.length]), s("Build", due, false, PEOPLE[(k + 1) % PEOPLE.length])],
    note: `Sample update ${k + 1}.`, prior: [], updatedOn: "2026-10-12", reports: [{ status, changed: true }],
  };
});

export const PROJECTS: MirrorProject[] = [...golden, ...filler];

/** Open dependencies: Supply blocks Rebate and Consignment. */
export const DEPENDENCIES = [
  { projectId: P(GOLDEN.REBATE), blockedById: P(GOLDEN.SUPPLY), note: "Supply agreement", createdAt: new Date("2026-09-20T15:00:00Z") },
  { projectId: P(GOLDEN.CONSIGNMENT), blockedById: P(GOLDEN.SUPPLY), note: null, createdAt: new Date("2026-10-05T15:00:00Z") },
];

/** One open external blocker with an overdue follow-up. */
export const BLOCKERS = [{ projectId: P(GOLDEN.CORTEX_EEG), description: "Vendor redlines", waitingOn: "Cortex Medical", since: new Date("2026-10-08T00:00:00Z"), followUpOn: new Date("2026-10-15T00:00:00Z"), followUpOwner: "Taylor Quinn", resolvedAt: null }];

export const SNAPSHOTS = [new Date("2026-10-13T16:00:00Z"), new Date("2026-09-29T16:00:00Z")];

type Where = Record<string, unknown>;
const inList = (v: unknown, x: string) => (v && typeof v === "object" && "in" in (v as object) ? ((v as { in: string[] }).in.includes(x)) : v === undefined || v === x);

/** Read-only fake of the tables the AI context reads, filled from the mirror. */
export class MirrorDb {
  history: { projectId: string; field: string; oldValue: string | null; newValue: string | null; changedAt: Date; changedBy: string; comment: string | null }[] = [];
  steps: { id: string; projectId: string; name: string; dueDate: Date | null; done: boolean; position: number; owner: string | null }[] = [];
  rows: Record<string, unknown>[] = [];
  glossaryRows = [
    { term: "SIVAT", definition: null as string | null, removedAt: null, position: 1 },
    { term: "MFI", definition: "Major Facility Investment", removedAt: null, position: 2 },
  ];
  roleTitle: string | null = "Director of an example service line";

  constructor() {
    for (const p of PROJECTS) {
      const id = P(p.i);
      const derived = p.steps.find((x) => !x.done) ?? null;
      this.rows.push({
        id, serviceLineId: LINE, name: p.name, status: p.status, nextMilestone: derived?.name ?? p.steps.at(-1)?.name ?? null, dueDate: derived?.due ? new Date(`${derived.due}T00:00:00Z`) : null, targetCompletion: null, note: p.note,
        inforRequestNumber: p.req, departmentId: DEPARTMENTS[p.dept - 1].id, description: p.description ?? null, isMfi: false, includeInReport: true, hiddenFromReport: false, owner: p.owner, physicianChampion: p.requester, requesterNotApplicable: false, contractsLead: p.contractsLead, reviewedAt: null, createdAt: new Date("2026-05-01T12:00:00Z"), archivedAt: null,
      });
      p.steps.forEach((x, k) => this.steps.push({ id: `${id.slice(0, 30)}${String(k).padStart(6, "0")}`, projectId: id, name: x.name, dueDate: x.due ? new Date(`${x.due}T00:00:00Z`) : null, done: x.done, position: k + 1, owner: x.owner }));
      this.history.push({ projectId: id, field: "status", oldValue: "NotStarted", newValue: p.status, changedAt: new Date(`${p.statusSince}T15:00:00Z`), changedBy: "admin@example.org", comment: null });
      const notes = [p.note, ...p.prior.map((x) => x.text)];
      p.prior.forEach((x, k) => this.history.push({ projectId: id, field: "note", oldValue: x.text, newValue: notes[k], changedAt: new Date(`${k === 0 ? p.updatedOn : x.replacedOn}T15:00:00Z`), changedBy: "admin@example.org", comment: null }));
      if (!p.prior.length) this.history.push({ projectId: id, field: "note", oldValue: null, newValue: p.note, changedAt: new Date(`${p.updatedOn}T15:00:00Z`), changedBy: "admin@example.org", comment: null });
    }
  }

  project = {
    findMany: async (args: { where: Where }) => {
      const w = args.where;
      return this.rows.filter((r) => (w.serviceLineId === undefined || r.serviceLineId === w.serviceLineId) && inList(w.id, r.id as string) && (w.archivedAt === undefined || r.archivedAt === null)).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    },
  };
  projectMilestone = { findMany: async (args: { where: Where }) => this.steps.filter((x) => inList(args.where.projectId, x.projectId)) };
  projectHistory = { findMany: async (args: { where: Where }) => this.history.filter((h) => inList(args.where.projectId, h.projectId)).sort((a, b) => b.changedAt.getTime() - a.changedAt.getTime()) };
  reportSnapshot = {
    findMany: async () =>
      SNAPSHOTS.map((at, k) => ({ generatedAt: at, rowsJson: PROJECTS.filter((p) => p.reports[k]).map((p) => ({ projectId: P(p.i), status: p.reports[k].status, changed: p.reports[k].changed })) })),
  };
  projectDependency = { findMany: async () => DEPENDENCIES };
  projectBlocker = { findMany: async (args: { where: Where }) => BLOCKERS.filter((b) => inList(args.where.projectId, b.projectId)) };
  aiGlossaryTerm = { findMany: async () => this.glossaryRows.filter((g) => !g.removedAt).sort((a, b) => a.position - b.position) };
  aiContextSetting = { findUnique: async () => ({ roleTitle: this.roleTitle }) };
  appUser = { findUnique: async () => ({ name: "Example Director" }) };
}
