import { randomBytes } from "node:crypto";
import { expect } from "vitest";
import type { FetchLike } from "@/lib/ai/AiProviderClient";
import { ServiceLine } from "@/lib/domain/ServiceLine";
import { AiSettingsService } from "@/lib/services/AiSettingsService";
import { AiProviderKeyService, type AiProviderKeyDb } from "@/lib/services/AiProviderKeyService";
import { FakeToolsDb } from "./FakeToolsDb";
import { Factory } from "./factories";

/** Shared setup for the AI tools tests (steps 4 to 9). Example data only. */
export const ENV = { AI_SETTINGS_ENCRYPTION_KEY: randomBytes(32).toString("base64") };
export const ADMIN = Factory.ADMIN;
export const MEMBER = Factory.MEMBER;
export const SCOPE = ServiceLine.defaultScope();
export const A = "10000000-0000-4000-8000-0000000000a1";
export const B = "10000000-0000-4000-8000-0000000000b2";
const FIELDS = { enabled: true, provider: "openai" as const, model: "gpt-6-luna", baseUrl: "", azureEndpoint: "", azureDeployment: "" };

export class MockProvider {
  calls: string[] = [];
  constructor(private reply: string, private status = 200) {}
  fetch: FetchLike = async (_url, init) => {
    this.calls.push(init.body);
    const payload = this.status === 200 ? { choices: [{ message: { content: this.reply } }] } : { error: { message: "down" } };
    return { ok: this.status === 200, status: this.status, text: async () => JSON.stringify(payload) };
  };
}

export async function toolsSetup() {
  const db = new FakeToolsDb();
  db.toolProjects.push({ id: A, serviceLineId: SCOPE.id, name: "Example Clinic refresh", status: "OnTrack", nextMilestone: "Vendor quote", dueDate: new Date("2026-11-01T00:00:00Z"), targetCompletion: null, note: "Quote requested." });
  db.toolProjects.push({ id: B, serviceLineId: SCOPE.id, name: "Sample Lab move", status: "AtRisk", nextMilestone: null, dueDate: null, targetCompletion: null, note: null });
  db.toolProjects.push({ id: "20000000-0000-4000-8000-000000000001", serviceLineId: "20000000-0000-4000-8000-0000000000ff", name: "Other line project", status: "OnTrack", nextMilestone: null, dueDate: null, targetCompletion: null, note: null });
  expect(await AiSettingsService.save(db, ADMIN, { allowedModels: ["gpt-6-luna"], fields: FIELDS, newKey: "sk-proj-TESTKEY-abcdefghijklmnop-WXYZ" }, ENV)).toEqual({ ok: true });
  // Item 2: the key registry already holds the OpenAI key (the one-time copy of the legacy key), as after migration.
  await AiProviderKeyService.ensureOpenAiCopied(db as unknown as AiProviderKeyDb, ENV);
  db.writes = [];
  return db;
}

