import { AiKeyShape } from "@/lib/ai/AiKeyShape";
import { AiModelKinds, type AiModelKind } from "@/lib/ai/AiModelKinds";
import { AiFeatureProviders, type AiFeatureProvider } from "@/lib/ai/AiFeatureProviders";

/** One cached model. Ids passed the gate; lifecycle and shutdownAt are for display only. */
export interface AiCachedModel {
  id: string;
  kind: AiModelKind | null;
  lifecycle?: string;
  shutdownAt?: string;
}

/** Short failure codes stored in ai_model_list_cache.lastError (DB check: [a-z_]{1,40}). Never a body or a key. */
export type AiListError =
  | "no_key"
  | "bad_base_url"
  | "http_error"
  | "redirect"
  | "timeout"
  | "network"
  | "too_large"
  | "invalid_json"
  | "too_deep"
  | "too_many"
  | "page_cap"
  | "empty_after_list"
  | "no_models";

/** A response as the gate reads it. A real fetch Response fits. */
export interface AiListResponse {
  ok: boolean;
  status: number;
  body?: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}

/**
 * The response gate for provider model lists (addendum g, 3.3). Every id returned by a provider goes through it before
 * it is cached or shown: the key detector (N2), the registry id shape, the id cleaner's rule (first character a letter or
 * digit, no '/') and a 100-character cap. Bodies are read as a stream and cut at 1 MB. Nothing here logs or returns the
 * text it refused, only counts and short codes.
 */
export class AiModelListGate {
  static readonly BODY_MAX = 1_048_576;
  static readonly ITEM_MAX = 2000;
  static readonly ID_MAX = 100;
  static readonly DEPTH_MAX = 16;
  static readonly ANTHROPIC_PAGE_MAX = 10;
  static readonly ANTHROPIC_PAGE_LIMIT = 1000;
  private static readonly CLEAN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

  /** True when an id may be cached and shown. */
  static idOk(id: unknown): id is string {
    if (typeof id !== "string") return false;
    if (id.length < 1 || id.length > AiModelListGate.ID_MAX) return false;
    if (!AiModelListGate.CLEAN.test(id)) return false;
    if (!AiKeyShape.MODEL_ID_SHAPE.test(id)) return false;
    return !AiKeyShape.looksLikeKey(id);
  }

  /** Nesting depth of a parsed JSON value; the root object or array counts as 1, scalars as 0. Iterative. */
  static depth(value: unknown): number {
    let max = 0;
    const stack: [unknown, number][] = [[value, 1]];
    while (stack.length) {
      const [v, d] = stack.pop()!;
      if (v === null || typeof v !== "object") continue;
      if (d > max) max = d;
      if (max > AiModelListGate.DEPTH_MAX) return max;
      for (const c of Array.isArray(v) ? v : Object.values(v as object)) stack.push([c, d + 1]);
    }
    return max;
  }

  /** The body as text, or "too_large" past BODY_MAX bytes (the stream is cancelled there). */
  static async readCapped(res: AiListResponse): Promise<string | "too_large"> {
    const cap = AiModelListGate.BODY_MAX;
    if (res.body && typeof res.body.getReader === "function") {
      const reader = res.body.getReader();
      const parts: Uint8Array[] = [];
      let n = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        n += value.byteLength;
        if (n > cap) {
          await reader.cancel().catch(() => undefined);
          return "too_large";
        }
        parts.push(value);
      }
      return Buffer.concat(parts.map((p) => Buffer.from(p))).toString("utf8");
    }
    const t = await res.text();
    return Buffer.byteLength(t, "utf8") > cap ? "too_large" : t;
  }

  /** Parse a body that passed the byte cap: JSON and depth. */
  static parseBody(text: string): { ok: true; body: unknown } | { ok: false; error: AiListError } {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return { ok: false, error: "invalid_json" };
    }
    if (AiModelListGate.depth(body) > AiModelListGate.DEPTH_MAX) return { ok: false, error: "too_deep" };
    return { ok: true, body };
  }

  /** The items of one page, gated. dropped = ids refused by the gate (count only). */
  static pageItems(provider: AiFeatureProvider, body: unknown): { models: AiCachedModel[]; dropped: number } | null {
    const data = (body as { data?: unknown } | null)?.data;
    if (!Array.isArray(data)) return null;
    const models: AiCachedModel[] = [];
    let dropped = 0;
    for (const raw of data) {
      const m = raw as { id?: unknown; type?: unknown; lifecycle?: unknown; shutdown_date?: unknown } | null;
      if (provider === "anthropic" && m?.type !== undefined && m?.type !== "model") continue;
      if (!AiModelListGate.idOk(m?.id)) {
        dropped += 1;
        continue;
      }
      const id = m!.id as string;
      const kind = provider === "openai" ? AiModelKinds.classify(id) : AiFeatureProviders.kindOf(provider, id);
      const out: AiCachedModel = { id, kind };
      if (provider === "anthropic" && typeof m!.lifecycle === "string" && /^[a-z_]{1,20}$/.test(m!.lifecycle)) out.lifecycle = m!.lifecycle;
      if (provider === "openai" && typeof m!.shutdown_date === "string" && /^\d{4}-\d{2}-\d{2}/.test(m!.shutdown_date)) out.shutdownAt = m!.shutdown_date.slice(0, 10);
      models.push(out);
    }
    return { models, dropped };
  }

  /** Merge pages, de-duplicate by id, sort. "too_many" past ITEM_MAX. */
  static merge(pages: readonly AiCachedModel[][]): AiCachedModel[] | "too_many" {
    const seen = new Map<string, AiCachedModel>();
    for (const p of pages) for (const m of p) if (!seen.has(m.id)) seen.set(m.id, m);
    if (seen.size > AiModelListGate.ITEM_MAX) return "too_many";
    return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /** The list URL of one page. Anthropic pages with limit and after_id; 'other' must be https. Null when refused. */
  static pageUrl(provider: AiFeatureProvider, baseUrl: string | null, afterId: string | null): string | null {
    switch (provider) {
      case "openai":
        return AiFeatureProviders.OPENAI_MODELS_URL;
      case "xai":
        return `${AiFeatureProviders.XAI_BASE_URL}/models`;
      case "anthropic": {
        const u = new URL("https://api.anthropic.com/v1/models");
        u.searchParams.set("limit", String(AiModelListGate.ANTHROPIC_PAGE_LIMIT));
        if (afterId) u.searchParams.set("after_id", afterId);
        return u.toString();
      }
      case "other": {
        if (!baseUrl) return null;
        let u: URL;
        try {
          u = new URL(baseUrl);
        } catch {
          return null;
        }
        if (u.protocol !== "https:") return null;
        return `${baseUrl.replace(/\/+$/, "")}/models`;
      }
    }
  }

  /** Anthropic paging fields of one page. */
  static anthropicNext(body: unknown): { hasMore: boolean; lastId: string | null } {
    const b = body as { has_more?: unknown; last_id?: unknown } | null;
    const lastId = typeof b?.last_id === "string" && AiModelListGate.idOk(b.last_id) ? b.last_id : null;
    return { hasMore: b?.has_more === true, lastId };
  }
}
