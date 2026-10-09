import type { AiSettingsHistoryRow, AiSettingsRow } from "@/lib/services/AiSettingsService";
import type { AiUsageRow, AiWritingDb } from "@/lib/services/AiWritingService";

type ProjectStub = { id: string; serviceLineId: string; departmentId: string | null; archivedAt: Date | null };

/**
 * In-memory stand-in for the AI tables (ai_settings, ai_settings_history, ai_usage_log) plus project reads. The logs
 * reject updates and deletes like the DB triggers do; every write is recorded in `writes` so tests can assert that a
 * call touched nothing else (no ProjectHistory, no Project).
 */
export class FakeAiDb implements AiWritingDb {
  settings: AiSettingsRow | null = null;
  settingsHistory: AiSettingsHistoryRow[] = [];
  usage: AiUsageRow[] = [];
  projects: ProjectStub[] = [];
  writes: string[] = [];

  aiSettings = {
    findUnique: async () => (this.settings ? { ...this.settings } : null),
    upsert: async (args: { create: AiSettingsRow; update: Partial<AiSettingsRow> }) => {
      this.writes.push("aiSettings.upsert");
      this.settings = this.settings ? { ...this.settings, ...args.update } : { ...args.create };
      return { ...this.settings };
    },
  };

  aiSettingsHistory = {
    createMany: async (args: { data: AiSettingsHistoryRow[] }) => {
      this.writes.push("aiSettingsHistory.createMany");
      for (const r of args.data) {
        if (r.field === "apiKey" && (r.oldValue !== null || r.newValue !== null)) throw new Error('violates check constraint "ai_settings_history_no_key_values"');
        this.settingsHistory.push({ ...r });
      }
      return { count: args.data.length };
    },
    findMany: async (args: { take: number }) => [...this.settingsHistory].sort((a, b) => b.changedAt.getTime() - a.changedAt.getTime()).slice(0, args.take),
  };

  aiUsageLog = {
    create: async (args: { data: AiUsageRow }) => {
      this.writes.push("aiUsageLog.create");
      this.usage.push({ ...args.data });
      return args.data;
    },
    findFirst: async (args: { where: { suggestionId: string; userEmail: string; event?: string | { in: string[] } } }) => {
      const w = args.where;
      const ev = (e: string) => (w.event === undefined ? true : typeof w.event === "string" ? e === w.event : w.event.in.includes(e));
      return this.usage.find((u) => u.suggestionId === w.suggestionId && u.userEmail === w.userEmail && ev(u.event)) ?? null;
    },
    count: async (args: { where: { userEmail: string; event: { in: string[] }; createdAt: { gte: Date } } }) =>
      this.usage.filter((u) => u.userEmail === args.where.userEmail && args.where.event.in.includes(u.event) && u.createdAt >= args.where.createdAt.gte).length,
  };

  project = {
    findUnique: async (args: { where: { id: string } }) => this.projects.find((p) => p.id === args.where.id) ?? null,
  };

  async $transaction<T>(fn: (tx: FakeAiDb) => Promise<T>): Promise<T> {
    const before = { settings: this.settings, history: [...this.settingsHistory], usage: [...this.usage] };
    try {
      return await fn(this);
    } catch (e) {
      this.settings = before.settings;
      this.settingsHistory = before.history;
      this.usage = before.usage;
      throw e;
    }
  }
}
