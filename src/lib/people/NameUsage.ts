import { PeopleDirectory } from "@/lib/people/PeopleDirectory";

/** Usage counts by lower-case normalized name, per picker (item 5). */
export interface NameUsageCounts {
  owner: Record<string, number>;
  requester: Record<string, number>;
  contracts: Record<string, number>;
}

/**
 * Name dropdown order (item 5, Oct 20, 2026): most used across the line's projects first, ties A to Z (ignoring
 * case). Pure and browser safe. Display order only: the stored lists are unchanged.
 */
export class NameUsage {
  static key(name: string | null | undefined): string {
    return PeopleDirectory.normalizeName(name).toLowerCase();
  }

  static count(values: readonly (string | null | undefined)[]): Record<string, number> {
    const out: Record<string, number> = {};
    for (const v of values) {
      const k = NameUsage.key(v);
      if (k) out[k] = (out[k] ?? 0) + 1;
    }
    return out;
  }

  static counts(projects: readonly { owner?: string | null; physicianChampion?: string | null; contractsLead?: string | null }[]): NameUsageCounts {
    return {
      owner: NameUsage.count(projects.map((p) => p.owner)),
      requester: NameUsage.count(projects.map((p) => p.physicianChampion)),
      contracts: NameUsage.count(projects.map((p) => p.contractsLead)),
    };
  }

  static sort(names: readonly string[], counts: Readonly<Record<string, number>> | undefined): string[] {
    const c = counts ?? {};
    return [...names].sort((a, b) => (c[NameUsage.key(b)] ?? 0) - (c[NameUsage.key(a)] ?? 0) || a.localeCompare(b, "en", { sensitivity: "base" }));
  }
}
