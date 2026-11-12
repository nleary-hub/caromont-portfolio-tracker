import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AiCopy } from "@/lib/ai/AiCopy";
import { AiFailureAlert, AiFailureCopy } from "@/lib/ai/AiFailureAlert";
import type { AiToggleFeature } from "@/lib/ai/AiFeatureFlags";
import { AiFeatureProviders, type AiFeatureProvider, type AiProviderKeyStates, type AiProviderSecret } from "@/lib/ai/AiFeatureProviders";
import { AiInputs } from "@/lib/ai/AiInput";
import type { AiCallResult, FetchLike } from "@/lib/ai/AiProviderClient";
import { AiToolsCopy } from "@/lib/ai/AiToolsCopy";
import { ServiceLine } from "@/lib/domain/ServiceLine";
import type { AiProviderKeySource } from "@/lib/services/AiFeatureProviderService";
import { AiFailureAlertService } from "@/lib/services/AiFailureAlertService";
import type { AiFeatureRow, AiModelRow } from "@/lib/services/AiModelService";
import { AiReviewApplyService } from "@/lib/services/AiReviewApplyService";
import { AiSettingsService } from "@/lib/services/AiSettingsService";
import { AiToolsService } from "@/lib/services/AiToolsService";
import { AiWritingService } from "@/lib/services/AiWritingService";
import { Factory } from "./helpers/factories";
import { FakeAiDb } from "./helpers/FakeAiDb";

// Fallback, "alert only" (Nick's choice, Nov 12): a failed text AI call is recorded for admins and shown at the top of
// Admin > AI settings; no other model is ever called. Behind AI_REGISTRY_RUNTIME, which is OFF unless set: with it off,
// nothing is recorded and every message is today's. Fictional people, models and keys only.
const ENV = { AI_SETTINGS_ENCRYPTION_KEY: randomBytes(32).toString("base64") };
const ON = { ...ENV, AI_REGISTRY_RUNTIME: "on" };
const SETTINGS_KEY = "sk-test-settings-EXAMPLE-0000000000000000";
const ADMIN = Factory.ADMIN;
const SCOPE = ServiceLine.defaultScope();
const PROJECT = "10000000-0000-4000-8000-0000000000aa";
const T0 = new Date("2026-11-12T15:00:00Z");
const now = () => T0;
const MAIN = { enabled: true, provider: "openai" as const, model: "gpt-example-main", baseUrl: "", azureEndpoint: "", azureDeployment: "" };
type Failure = Extract<AiCallResult, { ok: false }>;
const http = (status: number, message = `HTTP ${status}`): Failure => ({ ok: false, kind: "http", status, message, ms: 5 });

const model = (id: string): AiModelRow => ({ id, provider: "openai", enabled: true, priceUnit: "per_1m_tokens", inputPrice: 1, outputPrice: 4, addedAt: T0, addedBy: "a@example.org", updatedAt: T0, updatedBy: "a@example.org", kind: "chat" });

interface Ev {
  at: Date;
  category: string;
  primaryProvider: string;
  primaryModel: string;
  triggerClass: string;
  outcome: string;
  noFallbackReason: string | null;
  fallbackModel: string | null;
  httpStatus: number | null;
}

/** The AI tables in memory, plus ai_fallback_event and ai_fallback_ack (append-only, as in the database). */
class Db extends FakeAiDb {
  models: AiModelRow[] = [model("gpt-example-main")];
  featureRows: AiFeatureRow[] = [];
  events: Ev[] = [];
  acks: { at: Date; by: string; upToAt: Date }[] = [];
  failWrites = false;
  aiModel = { findMany: async () => [...this.models] } as never;
  aiFeatureSetting = { findMany: async () => this.featureRows.map((r) => ({ ...r })) };
  aiFallbackEvent = {
    create: async (a: { data: Record<string, unknown> }) => {
      if (this.failWrites) throw Object.assign(new Error("relation does not exist"), { name: "PrismaClientKnownRequestError" });
      this.events.push(a.data as unknown as Ev);
      return a.data;
    },
    findMany: async (a: { where: { at: { gt: Date } }; take: number }) =>
      this.events
        .filter((e) => e.at > a.where.at.gt && e.outcome === "no_fallback" && e.noFallbackReason === "none_set")
        .sort((x, y) => y.at.getTime() - x.at.getTime())
        .slice(0, a.take),
  };
  aiFallbackAck = {
    create: async (a: { data: { at: Date; by: string; upToAt: Date } }) => {
      this.acks.push(a.data);
      return a.data;
    },
    findFirst: async () => [...this.acks].sort((x, y) => y.upToAt.getTime() - x.upToAt.getTime())[0] ?? null,
  };
}

function keys(map: Partial<Record<AiFeatureProvider, AiProviderSecret>>): AiProviderKeySource {
  return {
    async states() {
      const out: Record<AiFeatureProvider, "ok" | "missing" | "failing"> = { ...AiFeatureProviders.noKeys() };
      for (const p of AiFeatureProviders.ALL) out[p] = map[p] ? "ok" : "missing";
      return out as AiProviderKeyStates;
    },
    async secret(p) {
      return map[p] ?? null;
    },
  };
}
const KEYS = keys({});

async function setup(): Promise<Db> {
  const db = new Db();
  db.modelRows = db.models;
  db.projects.push({ id: PROJECT, serviceLineId: SCOPE.id, departmentId: null, archivedAt: null });
  const saved = await AiSettingsService.save(db, ADMIN, { allowedModels: db.models.map((m) => m.id), fields: MAIN as never, newKey: SETTINGS_KEY }, ENV);
  expect(saved).toEqual({ ok: true });
  db.writes = [];
  return db;
}

/** A provider stub that always fails with the given HTTP status (or a timeout), counting its calls. */
function failing(status: number | "timeout", message = "") {
  let calls = 0;
  const f = (async () => {
    calls++;
    if (status === "timeout") throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
    return { ok: false, status, text: async () => JSON.stringify({ error: { message: message || `status ${status}` } }) };
  }) as unknown as FetchLike;
  return { f, calls: () => calls };
}

async function call(path: "writing" | "review" | "tools", db: Db, env: Record<string, string | undefined>, fetchImpl: FetchLike) {
  if (path === "writing") return AiWritingService.suggest({ db, viewer: ADMIN, scope: SCOPE, projectId: null, feature: "draft_from_bullets", text: "quote rcvd oct 6", env, fetchImpl, keys: KEYS, now });
  if (path === "review") return AiReviewApplyService.propose({ db, viewer: ADMIN, scope: SCOPE, projectId: PROJECT, feature: "revise_note", current: "Quote pending.", input: AiInputs.text("Say the quote came in Oct 6"), env, fetchImpl, keys: KEYS, now });
  return AiToolsService.call({ db: db as never, viewer: ADMIN, feature: "next_step" as never, input: "What next?", build: (input) => ({ system: "Be brief.", user: input, maxTokens: 4000 }), env, fetchImpl, keys: KEYS, now });
}
const PATHS = ["writing", "review", "tools"] as const;
const today = (path: (typeof PATHS)[number], timeout: boolean) => (path === "tools" ? (timeout ? AiToolsCopy.TIMEOUT : AiToolsCopy.PROVIDER_ERROR) : timeout ? AiCopy.TIMEOUT : AiCopy.PROVIDER_ERROR);

describe("which failures an admin is alerted to", () => {
  it("classifies timeouts, network errors, outages, rate limits, refused keys, retired models and empty credit", () => {
    expect(AiFailureAlert.classify({ ok: false, kind: "timeout", message: "Timed out", ms: 60_000 })).toBe("timeout");
    expect(AiFailureAlert.classify({ ok: false, kind: "network", message: "fetch failed", ms: 3 })).toBe("network");
    for (const s of [500, 502, 503, 529]) expect(AiFailureAlert.classify(http(s))).toBe("http_5xx");
    expect(AiFailureAlert.classify(http(429, "HTTP 429: Rate limit reached for requests"))).toBe("http_429");
    expect(AiFailureAlert.classify(http(429, "HTTP 429: You exceeded your current quota, please check your plan and billing details."))).toBe("billing_quota");
    expect(AiFailureAlert.classify(http(402))).toBe("billing_quota");
    expect(AiFailureAlert.classify(http(400, "HTTP 400: Your credit balance is too low to access the Anthropic API."))).toBe("billing_quota");
    expect(AiFailureAlert.classify(http(401, "HTTP 401: Incorrect API key provided: [key hidden]"))).toBe("key_rejected");
    expect(AiFailureAlert.classify(http(403))).toBe("key_rejected");
    expect(AiFailureAlert.classify(http(404, "HTTP 404: The model `gpt-example-old` does not exist or you do not have access to it."))).toBe("model_gone");
    expect(AiFailureAlert.classify(http(410))).toBe("model_gone");
    expect(AiFailureAlert.classify(http(400, "HTTP 400: The model gpt-example-old has been deprecated."))).toBe("model_gone");
  });

  it("ignores what isn't a provider failure: an empty reply, a reply cut off by its limit, a model off under Models, a bad request", () => {
    expect(AiFailureAlert.classify({ ok: false, kind: "empty", status: 200, message: "The provider returned no text", ms: 1 })).toBeNull();
    expect(AiFailureAlert.classify({ ok: false, kind: "length", status: 200, message: AiCopy.OUT_OF_REPLY_LENGTH, ms: 1 })).toBeNull();
    expect(AiFailureAlert.classify({ ok: false, kind: "model_not_allowed", message: AiCopy.MODEL_NOT_ALLOWED, ms: 0 })).toBeNull();
    expect(AiFailureAlert.classify(http(400, "HTTP 400: Invalid value for temperature"))).toBeNull();
    expect(AiFailureAlert.classify(http(422))).toBeNull();
  });

  it("only gone models, refused keys and empty credit get the 'trying again won't help' message", () => {
    for (const c of ["model_gone", "key_rejected", "billing_quota"] as const) expect(AiFailureAlert.notRetryable(c)).toBe(true);
    for (const c of ["timeout", "network", "http_5xx", "http_429", null] as const) expect(AiFailureAlert.notRetryable(c)).toBe(false);
  });

  it("names Azure and custom endpoints 'other', as the registry does", () => {
    expect(AiFailureAlert.providerOf("openai")).toBe("openai");
    expect(AiFailureAlert.providerOf("anthropic")).toBe("anthropic");
    expect(AiFailureAlert.providerOf("azure_openai")).toBe("other");
    expect(AiFailureAlert.providerOf("openai_compatible")).toBe("other");
  });
});

describe("switch off: nothing is recorded and every message is today's", () => {
  for (const path of PATHS) {
    it(`${path}: a retired model shows today's message and writes no failure row`, async () => {
      for (const env of [ENV, { ...ENV, AI_REGISTRY_RUNTIME: "off" }]) {
        const db = await setup();
        const p = failing(404, "The model `gpt-example-main` does not exist");
        const r = await call(path, db, env, p.f);
        expect(r).toMatchObject({ ok: false, kind: "provider", message: today(path, false) });
        expect(p.calls()).toBe(1);
        expect(db.events).toEqual([]);
      }
    });
  }

  it("the banner reads nothing and marking as seen is refused", async () => {
    const db = await setup();
    db.events.push({ at: T0, category: "drafting", primaryProvider: "openai", primaryModel: "gpt-example-main", triggerClass: "timeout", outcome: "no_fallback", noFallbackReason: "none_set", fallbackModel: null, httpStatus: null });
    expect(await AiFailureAlertService.view(db, (d) => d.toISOString(), ENV, T0)).toEqual({ ready: false, total: 0, groups: [], upToAt: null });
    expect((await AiFailureAlertService.acknowledge(db, "admin@example.org", T0.toISOString(), ENV, T0)).ok).toBe(false);
    expect(db.acks).toEqual([]);
  });
});

describe("switch on: alert only, never another model", () => {
  for (const path of PATHS) {
    it(`${path}: a retired model is recorded once, the person is told trying again won't help, and no other model is called`, async () => {
      const db = await setup();
      const p = failing(404, "The model `gpt-example-main` does not exist");
      const r = await call(path, db, ON, p.f);
      expect(r).toMatchObject({ ok: false, kind: "provider", message: path === "tools" ? AiFailureCopy.NOT_USABLE_TOOL : AiFailureCopy.NOT_USABLE_NOTE });
      expect(p.calls()).toBe(1);
      expect(db.events).toHaveLength(1);
      expect(db.events[0]).toMatchObject({ category: path === "tools" ? "analysis" : "drafting", primaryProvider: "openai", primaryModel: "gpt-example-main", triggerClass: "model_gone", httpStatus: 404, outcome: "no_fallback", noFallbackReason: "none_set", fallbackModel: null });
      // Classes and numbers only: no prompt, reply or provider message is stored.
      expect(JSON.stringify(db.events[0])).not.toMatch(/does not exist|quote|What next/);
    });

    it(`${path}: an outage or a timeout keeps today's "try again" message and is recorded`, async () => {
      const db = await setup();
      const outage = await call(path, db, ON, failing(503).f);
      expect(outage).toMatchObject({ ok: false, message: today(path, false) });
      const slow = await call(path, db, ON, failing("timeout").f);
      expect(slow).toMatchObject({ ok: false, kind: "timeout", message: today(path, true) });
      expect(db.events.map((e) => [e.triggerClass, e.httpStatus])).toEqual([
        ["http_5xx", 503],
        ["timeout", null],
      ]);
    });
  }

  it("a failure that can't be recorded still gives the person their message", async () => {
    const db = await setup();
    db.failWrites = true;
    const r = await AiWritingService.suggest({ db, viewer: ADMIN, scope: SCOPE, projectId: null, feature: "draft_from_bullets", text: "notes", env: ON, fetchImpl: failing(401).f, keys: KEYS, now });
    expect(r).toMatchObject({ ok: false, message: AiFailureCopy.NOT_USABLE_NOTE });
    expect(db.events).toEqual([]);
  });

  it("a bad request is not an alert and keeps today's message", async () => {
    const db = await setup();
    const r = await call("writing", db, ON, failing(400, "Invalid value for temperature").f);
    expect(r).toMatchObject({ ok: false, message: AiCopy.PROVIDER_ERROR });
    expect(db.events).toEqual([]);
  });

  it("dictation and voice chat are never recorded here (they have no category in the text registry)", async () => {
    const db = await setup();
    for (const feature of ["dictation", "voice_chat"] as AiToggleFeature[]) {
      expect(await AiFailureAlertService.record({ db, feature, config: { provider: "openai", model: "gpt-example-main" }, result: http(503), env: ON, now: T0 })).toBe("http_5xx");
    }
    expect(db.events).toEqual([]);
  });
});

describe("the Admin AI banner", () => {
  const ev = (minutesAgo: number, triggerClass: string, primaryModel = "gpt-example-main", category = "drafting"): Ev => ({
    at: new Date(T0.getTime() - minutesAgo * 60_000),
    category,
    primaryProvider: "openai",
    primaryModel,
    triggerClass,
    outcome: "no_fallback",
    noFallbackReason: "none_set",
    fallbackModel: null,
    httpStatus: null,
  });
  const when = (d: Date) => d.toISOString();

  it("groups failures by model, category and kind, newest first, in plain words", async () => {
    const db = await setup();
    db.events.push(ev(30, "timeout"), ev(10, "timeout"), ev(5, "model_gone", "gpt-example-old", "analysis"));
    const v = await AiFailureAlertService.view(db, when, ON, T0);
    expect(v.ready).toBe(true);
    expect(v.total).toBe(3);
    expect(v.groups).toEqual([
      { model: "gpt-example-old", category: "Analysis", reason: "model_gone", count: 1, lastAt: ev(5, "x").at.toISOString() },
      { model: "gpt-example-main", category: "Drafting", reason: "timeout", count: 2, lastAt: ev(10, "x").at.toISOString() },
    ]);
    expect(AiFailureCopy.line({ ...v.groups[1], last: "Nov 12, 2026, 9:50 AM ET" })).toBe("gpt-example-main (Drafting) took too long to answer: 2 times, last Nov 12, 2026, 9:50 AM ET.");
    expect(AiFailureCopy.title(1)).toBe("An AI call failed since this was last marked as seen");
    expect(AiFailureCopy.title(3)).toBe("AI calls failed 3 times since this was last marked as seen");
  });

  it("'Mark as seen' hides what was shown; a later failure brings the banner back", async () => {
    const db = await setup();
    db.events.push(ev(10, "http_5xx"));
    const shown = await AiFailureAlertService.view(db, when, ON, T0);
    expect(shown.upToAt).toBe(ev(10, "x").at.toISOString());
    expect(await AiFailureAlertService.acknowledge(db, "admin@example.org", shown.upToAt, ON, T0)).toEqual({ ok: true });
    expect(db.acks).toEqual([{ id: expect.any(String), at: T0, by: "admin@example.org", upToAt: ev(10, "x").at } as never]);
    expect((await AiFailureAlertService.view(db, when, ON, T0)).total).toBe(0);
    db.events.push(ev(-5, "http_429"));
    const later = new Date(T0.getTime() + 10 * 60_000);
    expect((await AiFailureAlertService.view(db, when, ON, later)).groups.map((g) => g.reason)).toEqual(["http_429"]);
  });

  it("a failure that lands after the page loaded is not marked as seen unshown", async () => {
    const db = await setup();
    db.events.push(ev(10, "timeout"));
    const shown = await AiFailureAlertService.view(db, when, ON, T0);
    db.events.push(ev(2, "model_gone"));
    expect(await AiFailureAlertService.acknowledge(db, "admin@example.org", shown.upToAt, ON, T0)).toEqual({ ok: true });
    expect((await AiFailureAlertService.view(db, when, ON, T0)).groups.map((g) => g.reason)).toEqual(["model_gone"]);
  });

  it("'Mark as seen' never acks past now and refuses a missing or bad time", async () => {
    const db = await setup();
    const future = new Date(T0.getTime() + 60 * 60_000).toISOString();
    expect(await AiFailureAlertService.acknowledge(db, "admin@example.org", future, ON, T0)).toEqual({ ok: true });
    expect((db.acks[0] as unknown as { upToAt: Date }).upToAt).toEqual(T0);
    for (const bad of [undefined, null, "", "not a date", 12345, "x".repeat(41)]) {
      expect(await AiFailureAlertService.acknowledge(db, "admin@example.org", bad, ON, T0)).toEqual({ ok: false, error: AiFailureCopy.ACK_FAILED });
    }
    expect(db.acks).toHaveLength(1);
  });

  it("looks back 30 days at most, and is read-only on a preview", async () => {
    const db = await setup();
    db.events.push(ev(31 * 24 * 60, "timeout"), ev(60, "network"));
    expect((await AiFailureAlertService.view(db, when, ON, T0)).groups.map((g) => g.reason)).toEqual(["network"]);
    expect(await AiFailureAlertService.acknowledge(db, "admin@example.org", T0.toISOString(), { ...ON, VERCEL_ENV: "preview" }, T0)).toEqual({ ok: false, error: AiFailureCopy.PREVIEW });
    expect(db.acks).toEqual([]);
  });

  it("tables that can't be read show no banner and never break the page", async () => {
    expect(await AiFailureAlertService.view({}, when, ON, T0)).toEqual({ ready: false, total: 0, groups: [], upToAt: null });
    const broken = { aiFallbackEvent: { create: async () => null, findMany: async () => Promise.reject(new Error("no table")) }, aiFallbackAck: { create: async () => null, findFirst: async () => null } };
    expect(await AiFailureAlertService.view(broken, when, ON, T0)).toEqual({ ready: false, total: 0, groups: [], upToAt: null });
  });
});
