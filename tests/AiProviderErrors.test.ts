import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiCommandBar } from "@/components/AiCommandBar";
import { AiLiveClient } from "@/lib/ai/AiLiveClient";
import { AiProviderClient, type AiRuntimeConfig, type FetchLike } from "@/lib/ai/AiProviderClient";
import { AiProviderError, type AiProviderErrorClass } from "@/lib/ai/AiProviderError";
import { AiRealtimeClient } from "@/lib/ai/AiRealtimeClient";
import { AiCommandConversation } from "@/lib/ai/command/AiCommandConversation";
import { AiReviewApplyService } from "@/lib/services/AiReviewApplyService";
import { AiToolsService } from "@/lib/services/AiToolsService";
import { AiWritingService } from "@/lib/services/AiWritingService";
import { ADMIN, ENV, SCOPE, toolsSetup } from "./helpers/aiTools";

vi.mock("@/app/actions/aiActions", () => ({ runAiCommand: vi.fn(), applyAiActions: vi.fn(), rejectAiActions: vi.fn() }));
vi.mock("@/app/actions/aiTools", () => ({ transcribeAiDictation: vi.fn(), proposeAiProjectDraft: vi.fn(), createAiProjectDraft: vi.fn() }));

// Provider errors are trimmed to fixed strings (CTO, Oct 29, 2026; QA F1). Every provider is an injected fake: no
// network, no key, no spend. The canary prompt and the key are fictional and are echoed back by the fake provider.
const PROMPT_MARK = "north stair rail zq81";
const PROMPT = `Canary prompt: the ${PROMPT_MARK} is loose`;
const SAVED_KEY = "sk-proj-TESTKEY-abcdefghijklmnop-WXYZ";
const KEY = ["sk", "proj", "CANARYKEY", "q7r8s9t0u1v2w3x4"].join("-");

/** Status per class, the exact OpenAI string pinned for each. */
const PINNED: [AiProviderErrorClass, number | null, string][] = [
  ["auth", 401, "OpenAI did not accept the API key (HTTP 401). Check the key in Provider keys."],
  ["auth", 403, "OpenAI did not accept the API key (HTTP 403). Check the key in Provider keys."],
  ["rate", 429, "OpenAI is rate limiting requests (HTTP 429). Wait a minute and try again."],
  ["bad_request", 400, "OpenAI could not use this request (HTTP 400). Check the model and settings, then try again."],
  ["bad_request", 404, "OpenAI could not use this request (HTTP 404). Check the model and settings, then try again."],
  ["bad_request", 422, "OpenAI could not use this request (HTTP 422). Check the model and settings, then try again."],
  ["server", 500, "OpenAI had a server error (HTTP 500). Try again in a few minutes."],
  ["server", 503, "OpenAI had a server error (HTTP 503). Try again in a few minutes."],
  ["timeout", 408, "OpenAI took too long to answer (HTTP 408). Try again."],
  ["timeout", 504, "OpenAI took too long to answer (HTTP 504). Try again."],
  ["other", 418, "OpenAI returned an error (HTTP 418). Try again."],
  ["provider_down", null, "OpenAI could not be reached. Try again in a few minutes."],
];

describe("fixed provider error strings", () => {
  it("the final class list", () => {
    expect(AiProviderError.CLASSES).toEqual(["auth", "rate", "bad_request", "server", "other", "timeout", "provider_down"]);
  });

  it.each(PINNED)("%s, HTTP %s: exact string", (cls, status, text) => {
    expect(AiProviderError.classify(status)).toBe(cls);
    expect(AiProviderError.forStatus("openai", status)).toBe(text);
  });

  it("names each provider and nothing else; timeout with no status", () => {
    expect(AiProviderError.forStatus("anthropic", 401)).toBe("Anthropic did not accept the API key (HTTP 401). Check the key in Provider keys.");
    expect(AiProviderError.forStatus("azure_openai", 500)).toBe("Azure OpenAI had a server error (HTTP 500). Try again in a few minutes.");
    expect(AiProviderError.forStatus("openai_compatible", 429)).toBe("The Other provider is rate limiting requests (HTTP 429). Wait a minute and try again.");
    expect(AiProviderError.message("openai", "timeout")).toBe("OpenAI took too long to answer. Try again.");
    for (const s of PINNED.map((p) => p[2])) expect(s).not.toContain("\u2014");
  });
});

type Echo = { status?: number; throws?: string };
/** Echoes the full request (prompt included) and a key back in the error body or the error message. */
function echo(e: Echo): FetchLike {
  return async (_url, init) => {
    if (e.throws) throw Object.assign(new Error(`${e.throws} ${KEY} ${init.body}`), { name: e.throws });
    const status = e.status ?? 500;
    const body = JSON.stringify({ error: { message: `echo ${KEY} ${SAVED_KEY} ${init.body}`, type: `bad ${PROMPT}`, code: PROMPT } });
    return { ok: false, status, text: async () => body };
  };
}
const CASES: [string, Echo][] = [...PINNED.filter((p) => p[1] !== null).map(([c, s]) => [`${c} ${s}`, { status: s! }] as [string, Echo]), ["provider_down (network)", { throws: "TypeError" }], ["timeout (abort)", { throws: "TimeoutError" }]];

describe("no prompt text or key reaches a result, the UI or the logs, for every class", () => {
  const logs: string[] = [];
  beforeEach(() => {
    logs.length = 0;
    for (const m of ["log", "info", "warn", "error", "debug", "trace"] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map((x) => (x instanceof Error ? `${x.name} ${x.message} ${x.stack}` : typeof x === "string" ? x : JSON.stringify(x))).join(" ")); });
    }
  });
  afterEach(() => vi.restoreAllMocks());
  const clean = (label: string, v: unknown) => {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    for (const bad of [PROMPT_MARK, "CANARYKEY", "TESTKEY", "WXYZ", "echo "]) expect(s, `${label}: ${bad}`).not.toContain(bad);
  };

  it.each(CASES)("%s: provider client and the voice clients", async (label, e) => {
    const config: AiRuntimeConfig = { provider: "openai", model: "gpt-6-luna", baseUrl: null, azureEndpoint: null, azureDeployment: null, apiKey: KEY, allowedModels: ["gpt-6-luna"] };
    const r = await AiProviderClient.complete(config, { system: PROMPT, user: PROMPT, maxTokens: 50 }, echo(e));
    expect(r.ok).toBe(false);
    clean(label, r);
    const voice = (async (_u: string, init: { body: string }) => echo(e)(_u, { ...init, method: "POST", headers: {}, signal: AbortSignal.timeout(1000) } as never)) as never;
    clean(label, await AiRealtimeClient.mint({ provider: "openai", apiKey: KEY }, { model: "gpt-realtime-fiction", instructions: PROMPT, tools: [], voice: "alloy" }, voice));
    clean(label, await AiLiveClient.create({ provider: "openai", apiKey: KEY }, { model: "gpt-live-fiction", instructions: PROMPT, voice: "alloy", backendModel: "gpt-6-luna", backendInstructions: PROMPT, tools: [] }, "v=0", voice));
    clean(`${label} logs`, logs.join("\n"));
  });

  it.each(CASES)("%s: writing, tools and review services (results and logs)", async (label, e) => {
    const db = await toolsSetup();
    const f = echo(e);
    let called = 0;
    const counted: FetchLike = async (u, i) => (called++, f(u, i));
    const w = await AiWritingService.suggest({ db: db as never, viewer: ADMIN, scope: SCOPE, projectId: null, feature: "draft_from_bullets", text: PROMPT, env: ENV, fetchImpl: counted });
    const t = await AiToolsService.proposeChanges({ db, viewer: ADMIN, scope: SCOPE, feature: "bulk_edit", input: PROMPT, env: ENV, fetchImpl: counted });
    const r = await AiReviewApplyService.propose({ db: db as never, viewer: ADMIN, scope: SCOPE, projectId: null, feature: "revise_note", current: PROMPT, input: { kind: "text", text: PROMPT }, env: ENV, fetchImpl: counted });
    expect(called, "the fake provider was reached").toBeGreaterThanOrEqual(3);
    for (const [n, v] of [["writing", w], ["tools", t], ["review", r]] as const) {
      expect((v as { ok: boolean }).ok, n).toBe(false);
      clean(`${label} ${n}`, v);
    }
    clean(`${label} logs`, logs.join("\n"));
  });

  it("UI: the command bar renders an echoed-prompt 400 as the fixed string only", async () => {
    const config: AiRuntimeConfig = { provider: "openai", model: "gpt-6-luna", baseUrl: null, azureEndpoint: null, azureDeployment: null, apiKey: KEY, allowedModels: ["gpt-6-luna"] };
    const r = await AiProviderClient.complete(config, { system: PROMPT, user: PROMPT, maxTokens: 50 }, echo({ status: 400 }));
    if (r.ok) throw new Error("expected a failure");
    const entries = AiCommandConversation.fold([], { ok: false, message: r.message } as never);
    const html = renderToStaticMarkup(createElement(AiCommandBar, { dictationNote: null, initial: entries }));
    expect(html).toContain("OpenAI could not use this request (HTTP 400). Check the model and settings, then try again.");
    clean("ui", html);
  });
});
