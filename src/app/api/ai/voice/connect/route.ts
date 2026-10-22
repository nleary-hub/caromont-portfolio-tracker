import { OwnerGate } from "@/lib/auth/OwnerGate";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { Db } from "@/lib/db/Db";
import { AiCopy } from "@/lib/ai/AiCopy";
import { AiVoiceConnectRoute } from "@/lib/ai/AiVoiceConnectRoute";
import type { AiToolsDb } from "@/lib/services/AiToolsService";

// Voice: the browser posts its WebRTC SDP offer here with its session id. Realtime models (gpt-realtime*): forwarded to
// OpenAI's realtime calls endpoint with the ephemeral client secret; the API key is never used. Live models
// (gpt-live-*): the server starts the session on OpenAI's Live API with the saved key, which never reaches the browser.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: Request) {
  const viewer = await OwnerGate.ownerViewer();
  if (!viewer?.isAdmin || !Db.isConfigured()) return Response.json({ error: { message: AiCopy.NOT_AUTHORIZED } }, { status: 403, headers: { "cache-control": "no-store" } });
  return AiVoiceConnectRoute.handle(request, { db: Db.client as unknown as AiToolsDb, viewer, scope: await ServiceLineAccess.activeFor(viewer) });
}
