import type { AiToolUsageRow, ProjectRowForTools } from "@/lib/services/AiToolsService";
import { FakeAiDb } from "./FakeAiDb";

/** FakeAiDb plus what the AI tools read: example projects (never real rows) and usage rows by line. */
export class FakeToolsDb extends FakeAiDb {
  toolProjects: (ProjectRowForTools & { serviceLineId: string })[] = [];
  featureRows: { feature: string; enabled: boolean; updatedAt: Date; updatedBy: string }[] = [];
  models: { id: string; enabled: boolean }[] = [{ id: "gpt-6-luna", enabled: true }];
  lastProjectQuery: unknown = null;

  aiFeatureSetting = { findMany: async () => this.featureRows };
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
}
