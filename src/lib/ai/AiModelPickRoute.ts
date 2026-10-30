import type { Viewer } from "@/lib/auth/AdminPolicy";
import { AiResponseCap } from "@/lib/ai/AiResponseCap";
import { AiModelPickerService, type AiLiveList } from "@/lib/services/AiModelPickerService";
import { AiRegistryCopy, type AiRegistryDb } from "@/lib/services/AiRegistryService";

type Env = Record<string, string | undefined>;
const NO_STORE = { "cache-control": "no-store" };

/** POST /api/ai/models/pick: the Owner picks a listed model for a category. The gate runs in the route file first. */
export class AiModelPickRoute {
  static readonly MAX_BODY_CHARS = 4_000;

  /**
   * Same-origin check for this cookie-authenticated POST. Sec-Fetch-Site must be "same-origin" when the browser sends it;
   * otherwise the Origin header must match the request's own origin. A request with neither header is refused.
   */
  static sameOrigin(request: Request): boolean {
    const site = request.headers.get("sec-fetch-site");
    if (site !== null) return site === "same-origin";
    const origin = request.headers.get("origin");
    if (!origin) return false;
    try {
      return new URL(origin).origin === new URL(request.url).origin;
    } catch {
      return false;
    }
  }

  static async handle(request: Request, deps: { db: AiRegistryDb; viewer: Viewer; env: Env; liveList: AiLiveList }): Promise<Response> {
    if (!AiModelPickRoute.sameOrigin(request)) return Response.json({ ok: false, error: AiRegistryCopy.NOT_AUTHORIZED }, { status: 403, headers: NO_STORE });
    let body: unknown;
    try {
      // Capped while streaming: the body is never buffered past MAX_BODY_CHARS bytes.
      const text = await AiResponseCap.text(request as unknown as Parameters<typeof AiResponseCap.text>[0], AiModelPickRoute.MAX_BODY_CHARS);
      if (text === null) return Response.json({ ok: false, error: AiRegistryCopy.SAVE_FAILED }, { status: 413, headers: NO_STORE });
      body = JSON.parse(text);
    } catch {
      return Response.json({ ok: false, error: AiRegistryCopy.SAVE_FAILED }, { status: 400, headers: NO_STORE });
    }
    const b = (body ?? {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" ? v : "");
    const r = await AiModelPickerService.pick(deps.db, deps.viewer, { provider: str(b.provider), model: str(b.model), category: str(b.category) }, deps.liveList, deps.env);
    return Response.json(r, { status: r.ok ? 200 : r.error === AiRegistryCopy.NOT_AUTHORIZED ? 403 : 422, headers: NO_STORE });
  }
}
