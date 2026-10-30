import type { Viewer } from "@/lib/auth/AdminPolicy";
import { AiModelPickerService, type AiLiveList } from "@/lib/services/AiModelPickerService";
import { AiRegistryCopy, type AiRegistryDb } from "@/lib/services/AiRegistryService";

type Env = Record<string, string | undefined>;
const NO_STORE = { "cache-control": "no-store" };

/** POST /api/ai/models/pick: the Owner picks a listed model for a category. The gate runs in the route file first. */
export class AiModelPickRoute {
  static readonly MAX_BODY_CHARS = 4_000;

  static async handle(request: Request, deps: { db: AiRegistryDb; viewer: Viewer; env: Env; liveList: AiLiveList }): Promise<Response> {
    let body: unknown;
    try {
      const text = await request.text();
      if (text.length > AiModelPickRoute.MAX_BODY_CHARS) return Response.json({ ok: false, error: AiRegistryCopy.SAVE_FAILED }, { status: 413, headers: NO_STORE });
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
