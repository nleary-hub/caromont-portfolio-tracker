import { OwnerGate } from "@/lib/auth/OwnerGate";
import { Db } from "@/lib/db/Db";
import { AiCopy } from "@/lib/ai/AiCopy";
import { AiModelPickRoute } from "@/lib/ai/AiModelPickRoute";
import { AiModelService, type AiModelDb } from "@/lib/services/AiModelService";
import type { AiRegistryDb } from "@/lib/services/AiRegistryService";

// Owner only: pick a model from the provider's live list for one category. The admin screen wiring comes in PR F.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 30 s: this route reads a provider model list and writes the registry. It never waits on a model reply.
export const maxDuration = 30;

export async function POST(request: Request) {
  const viewer = await OwnerGate.ownerViewer();
  if (!viewer?.isAdmin || !Db.isConfigured()) return Response.json({ error: { message: AiCopy.NOT_AUTHORIZED } }, { status: 403, headers: { "cache-control": "no-store" } });
  const db = Db.client as unknown as AiRegistryDb & AiModelDb;
  return AiModelPickRoute.handle(request, { db, viewer, env: process.env, liveList: (p) => AiModelService.listProvider(db, viewer, p) });
}
