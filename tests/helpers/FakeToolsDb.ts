import type { AiRelatedLinkRow, AiToolUsageRow, ProjectRowForTools } from "@/lib/services/AiToolsService";
import type { AiProviderKeyRow } from "@/lib/services/AiProviderKeyService";
import { FakeAiDb } from "./FakeAiDb";

/** FakeAiDb plus what the AI tools read: example projects (never real rows) and usage rows by line. */
export class FakeToolsDb extends FakeAiDb {
  toolProjects: (ProjectRowForTools & { serviceLineId: string })[] = [];
  featureRows: { feature: string; enabled: boolean; updatedAt: Date; updatedBy: string }[] = [];
  models: { id: string; enabled: boolean }[] = [{ id: "gpt-6-luna", enabled: true }];
  lastProjectQuery: unknown = null;

  aiFeatureSetting = { findMany: async () => this.featureRows };

  /**
   * Item 2: the key registry (ai_provider_keys). Voice and dictation read their OpenAI key here only; a legacy key in
   * `settings` is copied in on first read, as in the app. Set `providerKeys` to null to model a database without it.
   */
  keyRows: AiProviderKeyRow[] = [];
  providerKeys: boolean = true;
  get aiProviderKey() {
    if (!this.providerKeys) return undefined as never;
    return {
      findMany: async () => this.keyRows.map((r) => ({ ...r })),
      findUnique: async (args: { where: { provider: string } }) => {
        const r = this.keyRows.find((x) => x.provider === args.where.provider);
        return r ? { ...r } : null;
      },
      createMany: async (args: { data: AiProviderKeyRow[]; skipDuplicates: true }) => {
        this.writes.push("aiProviderKey.createMany");
        let count = 0;
        for (const r of args.data) {
          if (this.keyRows.some((x) => x.provider === r.provider)) continue;
          this.keyRows.push({ ...r });
          count += 1;
        }
        return { count };
      },
      update: async (args: { where: { provider: string }; data: Partial<AiProviderKeyRow> }) => {
        this.writes.push("aiProviderKey.update");
        const r = this.keyRows.find((x) => x.provider === args.where.provider);
        if (!r) throw new Error("Record to update not found.");
        Object.assign(r, args.data);
        return { ...r };
      },
    };
  }

  override async $transaction<T>(fn: (tx: FakeAiDb) => Promise<T>): Promise<T> {
    const keys = this.keyRows.map((r) => ({ ...r }));
    try {
      return await super.$transaction(fn);
    } catch (e) {
      this.keyRows = keys;
      throw e;
    }
  }
  aiModel = { findMany: async () => this.models as never[] };

  override aiUsageLog = {
    create: async (args: { data: AiToolUsageRow }) => {
      this.writes.push("aiUsageLog.create");
      this.usage.push({ ...args.data });
      return args.data;
    },
    findFirst: async (args: { where: Record<string, unknown> }) => {
      const w = args.where;
      const match = (u: AiToolUsageRow) =>
        Object.entries(w).every(([k, v]) => {
          const actual = (u as unknown as Record<string, unknown>)[k];
          if (v && typeof v === "object" && "in" in (v as object)) return (v as { in: unknown[] }).in.includes(actual);
          return actual === v;
        });
      return (this.usage as AiToolUsageRow[]).find(match) ?? null;
    },
    count: async (args: { where: { userEmail: string; event: { in: string[] }; createdAt: { gte: Date } } }) =>
      this.usage.filter((u) => u.userEmail === args.where.userEmail && args.where.event.in.includes(u.event) && u.createdAt >= args.where.createdAt.gte).length,
  };

  override project = {
    findUnique: async (args: { where: { id: string } }) => this.projects.find((p) => p.id === args.where.id) ?? null,
    findMany: async (args: { where: { serviceLineId: string; id?: string } }) => {
      this.lastProjectQuery = args;
      return this.toolProjects.filter((p) => p.serviceLineId === args.where.serviceLineId && (!args.where.id || p.id === args.where.id));
    },
  };

  linkRows: AiRelatedLinkRow[] = [];
  projectRelatedLink = {
    findMany: async (args: { where: { serviceLineId: string; removedAt: null } }) => this.linkRows.filter((r) => r.serviceLineId === args.where.serviceLineId && !r.removedAt),
    findUnique: async (args: { where: { id: string } | { projectAId_projectBId: { projectAId: string; projectBId: string } } }) => {
      const w = args.where;
      return this.linkRows.find((r) => ("id" in w ? r.id === w.id : r.projectAId === w.projectAId_projectBId.projectAId && r.projectBId === w.projectAId_projectBId.projectBId)) ?? null;
    },
    create: async (args: { data: AiRelatedLinkRow }) => {
      this.writes.push("projectRelatedLink.create");
      this.linkRows.push({ ...args.data });
      return args.data;
    },
    update: async (args: { where: { id: string }; data: Partial<AiRelatedLinkRow> }) => {
      this.writes.push("projectRelatedLink.update");
      const r = this.linkRows.find((x) => x.id === args.where.id)!;
      Object.assign(r, args.data);
      return r;
    },
  };
}
