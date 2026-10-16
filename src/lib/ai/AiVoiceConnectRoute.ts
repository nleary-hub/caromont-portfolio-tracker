import type { Viewer } from "@/lib/auth/AdminPolicy";
import { AiCopy } from "@/lib/ai/AiCopy";
import type { AiRealtimeFetch } from "@/lib/ai/AiRealtimeClient";
import type { ServiceLineScope } from "@/lib/domain/ServiceLine";
import type { AiToolsDb } from "@/lib/services/AiToolsService";
import { AiVoiceChatService } from "@/lib/services/AiVoiceChatService";

const NO_STORE = { "cache-control": "no-store" };

/** The testable body of POST /api/ai/voice/connect: JSON in ({ sessionId, clientSecret, sdp }), SDP answer out. A live (gpt-live-*) session sends no client secret. */
export class AiVoiceConnectRoute {
  static async handle(request: Request, deps: { db: AiToolsDb; viewer: Viewer | null; scope?: ServiceLineScope; fetchImpl?: AiRealtimeFetch; now?: () => Date }): Promise<Response> {
    if (!deps.viewer?.isAdmin) return Response.json({ error: { message: AiCopy.NOT_AUTHORIZED } }, { status: 403, headers: NO_STORE });
    let body: { sessionId?: unknown; clientSecret?: unknown; sdp?: unknown } = {};
    try {
      body = (await request.json()) as typeof body;
    } catch {
      body = {};
    }
    const r = await AiVoiceChatService.connect({ db: deps.db, viewer: deps.viewer, sessionId: body?.sessionId, clientSecret: body?.clientSecret, sdp: body?.sdp, scope: deps.scope, fetchImpl: deps.fetchImpl, now: deps.now });
    if (r.ok) return new Response(r.sdp, { status: 201, headers: { ...NO_STORE, "content-type": "application/sdp" } });
    return Response.json({ error: r.error }, { status: r.httpStatus, headers: NO_STORE });
  }
}
