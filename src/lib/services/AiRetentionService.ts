/** The narrow slice of Prisma the retention job uses (tests pass an in-memory fake or PGlite). */
export interface AiRetentionDb {
  aiUsageLog: {
    updateMany(args: {
      where: { createdAt: { lt: Date }; OR: ({ suggestedText: { not: null } } | { userEmail: { not: string } })[] };
      data: { suggestedText: null; userEmail: string };
    }): Promise<{ count: number }>;
  };
}

/**
 * AI usage log retention: rows older than 30 days keep their metadata (feature, event, provider, model, lengths, time)
 * but lose the suggested text and the user's email. Nothing is deleted. Rows 30 days old or newer are untouched.
 * The 0035 trigger allows exactly this update and nothing else.
 */
export class AiRetentionService {
  static readonly DAYS = 30;
  static readonly REMOVED_EMAIL = "[removed]";

  static cutoff(now: Date): Date {
    return new Date(now.getTime() - AiRetentionService.DAYS * 24 * 60 * 60 * 1000);
  }

  static async run(db: AiRetentionDb, now: Date = new Date()): Promise<{ scrubbed: number; cutoff: string }> {
    const cutoff = AiRetentionService.cutoff(now);
    const r = await db.aiUsageLog.updateMany({
      where: { createdAt: { lt: cutoff }, OR: [{ suggestedText: { not: null } }, { userEmail: { not: AiRetentionService.REMOVED_EMAIL } }] },
      data: { suggestedText: null, userEmail: AiRetentionService.REMOVED_EMAIL },
    });
    return { scrubbed: r.count, cutoff: cutoff.toISOString() };
  }
}
