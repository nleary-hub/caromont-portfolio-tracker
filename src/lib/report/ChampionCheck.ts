import { ProjectStatusInfo } from "@/lib/domain/ProjectStatusInfo";
import type { MissingChampion, ProjectRecord, RecipientRecord } from "@/lib/domain/types";

/**
 * Finds requesters (stored as physicianChampion) on active projects who are not active report
 * recipients. Rows marked Not applicable are never flagged. Report-only: never creates recipients.
 */
export class ChampionCheck {
  static normalizeEmail(email: string | null | undefined): string | null {
    const e = email?.trim().toLowerCase();
    return e ? e : null;
  }

  static normalizeName(name: string | null | undefined): string | null {
    const n = name?.trim().replace(/\s+/g, " ").toLowerCase();
    return n ? n : null;
  }

  /** Active = not archived and not Complete/Cancelled (includeInReport is irrelevant here). */
  static isActiveProject(project: ProjectRecord): boolean {
    return !project.archivedAt && !ProjectStatusInfo.isClosed(project.status);
  }

  /** Is this requester covered by an active recipient? Email match when the requester has an email, else name match. */
  static isCovered(
    champion: { name: string | null; email: string | null },
    recipients: readonly RecipientRecord[],
  ): boolean {
    const active = recipients.filter((r) => r.active);
    const email = ChampionCheck.normalizeEmail(champion.email);
    if (email) return active.some((r) => ChampionCheck.normalizeEmail(r.email) === email);
    const name = ChampionCheck.normalizeName(champion.name);
    if (!name) return true; // no requester at all
    return active.some((r) => ChampionCheck.normalizeName(r.name) === name);
  }

  static findMissing(
    projects: readonly ProjectRecord[],
    recipients: readonly RecipientRecord[],
  ): MissingChampion[] {
    const byKey = new Map<string, MissingChampion>();
    for (const p of projects) {
      if (!ChampionCheck.isActiveProject(p) || p.requesterNotApplicable) continue;
      const email = ChampionCheck.normalizeEmail(p.physicianChampionEmail);
      const name = p.physicianChampion?.trim().replace(/\s+/g, " ") || null;
      if (!email && !name) continue;
      if (ChampionCheck.isCovered({ name, email }, recipients)) continue;

      const key = email ? `email:${email}` : `name:${ChampionCheck.normalizeName(name)}`;
      const entry = byKey.get(key) ?? {
        name: name ?? email ?? "",
        email,
        projectIds: [],
        projectNames: [],
      };
      entry.projectIds.push(p.id);
      entry.projectNames.push(p.name);
      byKey.set(key, entry);
    }
    return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
  }
}
