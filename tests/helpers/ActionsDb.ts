import type { MilestoneDraft } from "@/lib/domain/MilestoneRules";
import type { AiActionPorts, AiBlockerFields } from "@/lib/services/AiActionService";
import type { AiToolUsageRow } from "@/lib/services/AiToolsService";
import { BLOCKERS, DEPENDENCIES, LINE, MirrorDb } from "../fixtures/portfolio-mirror";

type Where = Record<string, unknown>;
const matches = (row: Record<string, unknown>, w: Where) =>
  Object.entries(w).every(([k, v]) => {
    const actual = row[k];
    if (v && typeof v === "object" && "in" in (v as object)) return (v as { in: unknown[] }).in.includes(actual);
    if (v && typeof v === "object" && "gte" in (v as object)) return actual instanceof Date && actual >= (v as { gte: Date }).gte;
    return actual === v;
  });

/** The fictional mirror plus the tables the action layer writes (in memory). Example data only. */
export class ActionsDb extends MirrorDb {
  usage: AiToolUsageRow[] = [];
  proposals: Record<string, unknown>[] = [];
  applies: Record<string, unknown>[] = [];
  blockerRows = BLOCKERS.map((b) => ({ ...b }));
  depRows = DEPENDENCIES.map((d) => ({ ...d, removedAt: null as Date | null }));
  featureRows: { feature: string; enabled: boolean }[] = [];

  aiFeatureSetting = { findMany: async () => this.featureRows };
  aiUsageLog = {
    create: async (args: { data: AiToolUsageRow }) => {
      this.usage.push({ ...args.data });
      return args.data;
    },
    findFirst: async (args: { where: Where }) => this.usage.find((u) => matches(u as unknown as Record<string, unknown>, args.where)) ?? null,
    count: async () => 0,
  };
  aiProposal = {
    create: async (args: { data: Record<string, unknown> }) => this.proposals.push(structuredClone(args.data)),
    findUnique: async (args: { where: { id: string } }) => (this.proposals.find((p) => p.id === args.where.id) as never) ?? null,
  };
  aiApply = {
    create: async (args: { data: Record<string, unknown> }) => this.applies.push(structuredClone({ ...args.data, undoneAt: null, undoneBy: null })),
    findFirst: async (args: { where: Where }) => (this.applies.filter((a) => matches(a, args.where)).sort((a, b) => (b.appliedAt as Date).getTime() - (a.appliedAt as Date).getTime())[0] as never) ?? null,
    update: async (args: { where: { id: string }; data: Record<string, unknown> }) => Object.assign(this.applies.find((a) => a.id === args.where.id)!, args.data),
  };
  override projectBlocker = { findMany: async (args: { where: Where }) => this.blockerRows.filter((b) => !b.resolvedAt && (!args.where.projectId || (args.where.projectId as { in: string[] }).in.includes(b.projectId))) };
  override projectDependency = { findMany: async () => this.depRows.filter((d) => !d.removedAt) };

  row(id: string) {
    return this.rows.find((r) => r.id === id)!;
  }

  stepsOf(id: string) {
    return this.steps.filter((s) => s.projectId === id).sort((a, b) => a.position - b.position);
  }
}

/** Records every write with its history tag and applies it to the in-memory mirror (stand-in for the real services). */
export class FakePorts implements AiActionPorts {
  calls: { op: string; projectId: string; comment: string | null; detail: unknown }[] = [];
  reviewed = new Map<string, string>();
  private n = 0;
  constructor(private db: ActionsDb) {}

  async update(projectId: string, patch: Record<string, string | boolean | null>, comment: string) {
    this.calls.push({ op: "update", projectId, comment, detail: patch });
    const r = this.db.row(projectId);
    for (const [k, v] of Object.entries(patch)) r[k] = (k === "dueDate" || k === "targetCompletion") && typeof v === "string" ? new Date(`${v}T00:00:00Z`) : v;
  }
  async people(projectId: string, field: string, value: string, comment: string) {
    this.calls.push({ op: "people", projectId, comment, detail: { field, value } });
    const r = this.db.row(projectId);
    if (field === "serviceArea") r.departmentId = value || null;
    else if (field === "requesterNotApplicable") r.requesterNotApplicable = value === "true";
    else r[field] = value || null;
  }
  async saveSteps(projectId: string, drafts: MilestoneDraft[], comment: string) {
    this.calls.push({ op: "steps", projectId, comment, detail: drafts });
    this.db.steps = this.db.steps.filter((s) => s.projectId !== projectId);
    drafts.forEach((d, k) => this.db.steps.push({ id: d.id ?? `79000000-0000-4000-8000-${String(++this.n).padStart(12, "0")}`, projectId, name: d.name, dueDate: d.dueDate ? new Date(`${d.dueDate}T00:00:00Z`) : null, done: d.done, position: k + 1, owner: d.owner ?? null }));
  }
  async markReviewed(projectId: string) {
    const at = "2026-10-17T14:00:00.000Z";
    this.calls.push({ op: "reviewed", projectId, comment: null, detail: at });
    this.reviewed.set(projectId, at);
    return at;
  }
  async undoReviewed(projectId: string, at: string) {
    this.calls.push({ op: "unreviewed", projectId, comment: null, detail: at });
    return this.reviewed.delete(projectId);
  }
  async addBlocker(projectId: string, input: AiBlockerFields, comment: string) {
    const id = `72000000-0000-4000-8000-${String(++this.n).padStart(12, "0")}`;
    this.calls.push({ op: "addBlocker", projectId, comment, detail: input });
    this.db.blockerRows.push({ id, serviceLineId: LINE, projectId, description: input.description, waitingOn: input.waitingOn, since: new Date(), followUpOn: input.followUpOn ? new Date(`${input.followUpOn}T00:00:00Z`) : (null as unknown as Date), followUpOwner: input.followUpOwner ?? "", resolvedAt: null });
    return id;
  }
  async updateBlocker(projectId: string, blockerId: string, input: AiBlockerFields, comment: string) {
    this.calls.push({ op: "updateBlocker", projectId, comment, detail: input });
    const b = this.db.blockerRows.find((x) => x.id === blockerId)!;
    Object.assign(b, { description: input.description, waitingOn: input.waitingOn, followUpOn: input.followUpOn ? new Date(`${input.followUpOn}T00:00:00Z`) : null, followUpOwner: input.followUpOwner });
  }
  async resolveBlocker(projectId: string, blockerId: string, resolution: string, comment: string) {
    this.calls.push({ op: "resolveBlocker", projectId, comment, detail: resolution });
    (this.db.blockerRows.find((x) => x.id === blockerId) as { resolvedAt: unknown }).resolvedAt = new Date();
  }
  async addDependency(projectId: string, blockedById: string, note: string | null, comment: string) {
    this.calls.push({ op: "addDependency", projectId, comment, detail: { blockedById, note } });
    this.db.depRows.push({ serviceLineId: LINE, projectId, blockedById, note, createdAt: new Date(), removedAt: null });
  }
  async removeDependency(projectId: string, blockedById: string, comment: string) {
    this.calls.push({ op: "removeDependency", projectId, comment, detail: { blockedById } });
    this.db.depRows.find((d) => d.projectId === projectId && d.blockedById === blockedById && !d.removedAt)!.removedAt = new Date();
  }
}
