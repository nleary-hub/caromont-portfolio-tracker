import { CurrentViewer } from "@/lib/auth/CurrentViewer";
import { Db } from "@/lib/db/Db";
import { AiCopy } from "@/lib/ai/AiCopy";
import { AiVoiceConnectRoute } from "@/lib/ai/AiVoiceConnectRoute";
import type { AiToolsDb } from "@/lib/services/AiToolsService";

// Voice hotfix: the browser posts its WebRTC SDP offer here with the ephemeral client secret and session id; the
// server forwards it to OpenAI's realtime calls endpoint and returns the SDP answer. Admin only. The API key is never used.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function POST(request: Request) {
  const viewer = await CurrentViewer.get();
  if (!viewer?.isAdmin || !Db.isConfigured()) return Response.json({ error: { message: AiCopy.NOT_AUTHORIZED } }, { status: 403, headers: { "cache-control": "no-store" } });
  return AiVoiceConnectRoute.handle(request, { db: Db.client as unknown as AiToolsDb, viewer });
}
