import { AiModelListGate } from "@/lib/ai/AiModelListGate";

/**
 * Addendum g 3.5: a raw model id from the admin page is accepted only when it is in that provider's current cached list
 * (ai_model_list_cache, after the response gate). Read-only. A database without the cache table (an in-memory fake that
 * predates 0072) reads as "no check" (null); the real Prisma client always has it, so production is strict.
 */
export class AiModelListCheck {
  static readonly NOT_IN_LIST = "This model is not in the provider's current list";

  static async inList(db: unknown, provider: string, id: string): Promise<boolean | null> {
    const cache = (db as { aiModelListCache?: { findUnique?: (a: { where: { provider: string } }) => Promise<{ models: unknown } | null> } })?.aiModelListCache;
    if (typeof cache?.findUnique !== "function") return null;
    const row = await cache.findUnique({ where: { provider } }).catch(() => null);
    const models = Array.isArray(row?.models) ? (row!.models as unknown[]) : [];
    return AiModelListGate.idOk(id) && models.some((m) => (m as { id?: unknown })?.id === id);
  }

  /** The refusal text, or null when the id may pass. */
  static async refusal(db: unknown, provider: string, id: string): Promise<string | null> {
    return (await AiModelListCheck.inList(db, provider, id)) === false ? AiModelListCheck.NOT_IN_LIST : null;
  }
}
