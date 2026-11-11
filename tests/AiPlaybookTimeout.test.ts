import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AiFeatureProviders, type AiFeatureProvider, type AiProviderSecret } from "@/lib/ai/AiFeatureProviders";
import { AiModelDefaults } from "@/lib/ai/AiModelDefaults";
import { AiProviderClient, type FetchLike } from "@/lib/ai/AiProviderClient";
import { AiToolsCopy } from "@/lib/ai/AiToolsCopy";
import { AiPlaybookModel } from "@/lib/ai/playbook/AiPlaybookModel";
import type { AiProviderKeySource } from "@/lib/services/AiFeatureProviderService";
import type { AiFeatureRow, AiModelRow } from "@/lib/services/AiModelService";
import { AiPlaybookService } from "@/lib/services/AiPlaybookService";
import { AiSettingsService } from "@/lib/services/AiSettingsService";
import { AiToolsService } from "@/lib/services/AiToolsService";
import { Factory } from "./helpers/factories";
import { FakeAiDb } from "./helpers/FakeAiDb";

// The Meeting Playbook timed out at the shared 60 s provider limit (5 of its first 6 runs on gpt-6.1-sol, Oct 21 and
// Nov 5). It now waits AiPlaybookModel.TIMEOUT_MS; every other AI tool keeps 60 s. Example data only.

const ENV = { AI_SETTINGS_ENCRYPTION_KEY: randomBytes(32).toString("base64") };
const OPENAI_KEY = "sk-test-openai-EXAMPLE-0000000000000000";
const ADMIN = Factory.ADMIN;
const T0 = new Date("2026-10-18T12:00:00Z");
const FIELDS = { enabled: true, provider: "openai" as const, model: "gpt-6-luna", baseUrl: "", azureEndpoint: "", azureDeployment: "" };

const model = (id: string): AiModelRow => ({ id, provider: "openai", enabled: true, priceUnit: "per_1m_tokens", inputPrice: "1.25", outputPrice: "10", addedAt: T0, addedBy: "a@example.org", updatedAt: T0, updatedBy: "a@example.org", kind: null });
const row = (feature: string, m: string): AiFeatureRow => ({ feature, enabled: true, updatedAt: T0, updatedBy: AiModelDefaults.SEEDED_BY, provider: "openai", model: m, defaultModel: m });

class FakeDb extends FakeAiDb {
  models: AiModelRow[] = [model("gpt-6-luna"), model("gpt-6.1-sol")];
  featureRows: AiFeatureRow[] = [row("meeting_brief", "gpt-6.1-sol"), row("meeting_notes", "gpt-6.1-sol")];
  aiProviderKey = { findMany: async () => [{ provider: "openai", ciphertext: "fake-ciphertext-marker" }] };
  aiModel = { findMany: async () => [...this.models], findUnique: async (a: { where: { id: string } }) => this.models.find((m) => m.id === a.where.id) ?? null } as never;
  aiFeatureSetting = { findMany: async () => this.featureRows.map((r) => ({ ...r })) };
}

function keys(map: Partial<Record<AiFeatureProvider, AiProviderSecret>>): AiProviderKeySource {
  return {
    async states() {
      return { ...AiFeatureProviders.noKeys(), ...Object.fromEntries(Object.keys(map).map((p) => [p, "ok"])) };
    },
    async secret(p) {
      return map[p] ?? null;
    },
  };
}
const OPENAI = keys({ openai: { apiKey: OPENAI_KEY, baseUrl: null } });

async function setup(): Promise<FakeDb> {
  const db = new FakeDb();
  db.modelRows = db.models;
  await AiSettingsService.save(db, ADMIN, { allowedModels: ["gpt-6-luna"], fields: FIELDS, newKey: OPENAI_KEY }, ENV);
  db.settingsHistory = [];
  db.writes = [];
  return db;
}

/** A provider that never answers: it only settles when the request's signal aborts, like a slow reasoning model. */
const hangs = ((_url: string, init: { signal: AbortSignal }) =>
  new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason));
  })) as unknown as FetchLike;

const call = (db: FakeDb, feature: "meeting_brief" | "meeting_notes", fetchImpl: FetchLike, timeoutMs?: number) =>
  AiToolsService.call({ db: db as never, viewer: ADMIN, feature, input: "Fictional focus: Cath lab 3 refresh", build: (i) => ({ system: "s", user: i, maxTokens: 50 }), env: ENV, fetchImpl, keys: OPENAI, ...(timeoutMs ? { timeoutMs } : {}) });

afterEach(() => vi.restoreAllMocks());

describe("Meeting Playbook provider wait", () => {
  it("the shared call passes its timeout to the provider; without one it keeps the 60 s default", async () => {
    const db = await setup();
    const spy = vi.spyOn(AiProviderClient, "complete");
    const r = await call(db, "meeting_brief", hangs, 40);
    expect(r).toEqual({ ok: false, kind: "timeout", message: AiToolsCopy.TIMEOUT });
    expect(spy.mock.calls[0][3]).toBe(40);
    // A timed-out run still writes its failed row, so the rate limit and the spend cap see it as before.
    expect(db.usage).toEqual([expect.objectContaining({ feature: "meeting_brief", event: "failed", model: "gpt-6.1-sol" })]);

    spy.mockResolvedValueOnce({ ok: true, text: "ok", ms: 5, usage: { inputTokens: 10, outputTokens: 5 } });
    await call(db, "meeting_notes", hangs);
    expect(spy.mock.calls[1][3]).toBeUndefined();
    expect(AiProviderClient.TIMEOUT_MS).toBe(60_000);
  });

  it("the playbook asks for the longer wait; it is well above the old 60 s and fits the page's maxDuration on Vercel", async () => {
    expect(AiPlaybookModel.TIMEOUT_MS).toBe(150_000);
    expect(AiPlaybookModel.TIMEOUT_MS).toBeGreaterThan(AiProviderClient.TIMEOUT_MS * 2);
    const src = readFileSync(path.resolve(__dirname, "../src/app/playbook/page.tsx"), "utf8");
    const m = src.match(/^export const maxDuration = (\d+);$/m);
    expect(m).not.toBeNull();
    const seconds = Number(m![1]);
    expect(seconds).toBeGreaterThanOrEqual(AiPlaybookModel.TIMEOUT_MS / 1000 + 15);
    // Vercel Hobby with Fluid compute allows at most 300 s.
    expect(seconds).toBeLessThanOrEqual(300);
  });

  it("generate hands AiPlaybookModel.TIMEOUT_MS to the shared call", async () => {
    const spy = vi.spyOn(AiToolsService, "call").mockResolvedValue({ ok: false, kind: "timeout", message: AiToolsCopy.TIMEOUT });
    const db = Object.assign(await setup(), {
      project: { findMany: async () => [{ id: "00000000-0000-4000-8000-000000000001", name: "Sample project", status: "On Track", nextMilestone: null, dueDate: null, targetCompletion: null, note: null }] },
      aiPlaybook: { create: async () => null, findMany: async () => [], findUnique: async () => null },
    });
    vi.spyOn(await import("@/lib/services/PortfolioContextService").then((m) => m.PortfolioContextService), "load").mockResolvedValue({ projects: [{ ref: "P1", name: "Sample project" }] } as never);
    vi.spyOn(await import("@/lib/ai/context/PortfolioContext").then((m) => m.PortfolioContext), "build").mockReturnValue({ text: "context" } as never);
    const r = await AiPlaybookService.generate({ db: db as never, viewer: ADMIN, scope: { id: "line-1", name: "Sample line" } as never, meetingType: "huddle", playbookScope: { kind: "line" }, length: 15, focus: "", env: ENV, keys: OPENAI });
    expect(r).toEqual({ ok: false, message: AiToolsCopy.TIMEOUT });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ feature: "meeting_brief", timeoutMs: AiPlaybookModel.TIMEOUT_MS }));
  });
});
