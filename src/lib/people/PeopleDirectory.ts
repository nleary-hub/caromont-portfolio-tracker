import { AppConfig } from "@/lib/config/AppConfig";

/** Which people field a list is for. */
export type PeopleRole = "owner" | "requester";

/** One piece of a name split around the typed text (match = shown at weight 600). */
export interface NameSegment {
  text: string;
  match: boolean;
}

/**
 * Name rules shared by the owner and requester pick-lists. The lists themselves are managed per line on
 * Admin > People (ServiceLineScope.owners / requesters, migration 0020); merge() cleans them for the comboboxes.
 */
export class PeopleDirectory {
  /** Built-in owners (department leaders), merged with the owners in use. Requesters start empty. */
  static readonly OWNER_SEED: readonly string[] = ["Nicole Smith", "Nick Leary"];

  /** Longest name the server accepts. */
  static readonly NAME_MAX = AppConfig.SHORT_TEXT_MAX_LENGTH;

  /** Names that must never be suggested (compared case-insensitively). */
  private static readonly NEVER_SUGGEST: ReadonlySet<string> = new Set(["mark wingard", "mark garland"]);

  /** Placeholder values that mean "nobody yet"; saved as blank. */
  private static readonly TO_ASSIGN_WORDS: ReadonlySet<string> = new Set(["to assign", "clear (to assign)", "unassigned", "tbd"]);

  /** Not applicable spellings (the requester has a real Not applicable state). */
  private static readonly NOT_APPLICABLE_WORDS: ReadonlySet<string> = new Set(["not applicable", "n/a", "na"]);

  /** Trim and collapse runs of whitespace to one space. */
  static normalizeName(raw: string | null | undefined): string {
    return typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  }

  /** Blocked names: never offered or added to a list. Projects keep them. */
  static isBlocked(raw: string | null | undefined): boolean {
    return PeopleDirectory.NEVER_SUGGEST.has(PeopleDirectory.key(raw));
  }

  static isToAssignText(raw: string | null | undefined): boolean {
    return PeopleDirectory.TO_ASSIGN_WORDS.has(PeopleDirectory.key(raw));
  }

  static isNotApplicableText(raw: string | null | undefined): boolean {
    return PeopleDirectory.NOT_APPLICABLE_WORDS.has(PeopleDirectory.key(raw));
  }

  /** Placeholder or Not applicable text; never a person and never listed. */
  static isSentinel(raw: string | null | undefined): boolean {
    return PeopleDirectory.isToAssignText(raw) || PeopleDirectory.isNotApplicableText(raw);
  }

  /** Owner options: the seed (built-in owners; ServiceLineAccess.ownerSeed gives none for a new line) plus owners in use. */
  static owners(inUse: readonly (string | null | undefined)[], seed: readonly string[] = PeopleDirectory.OWNER_SEED): string[] {
    return PeopleDirectory.merge([...seed, ...inUse]);
  }

  /** Requester options: distinct requesters in use. */
  static requesters(inUse: readonly (string | null | undefined)[]): string[] {
    return PeopleDirectory.merge(inUse);
  }

  static forRole(role: PeopleRole, inUse: readonly (string | null | undefined)[], seed: readonly string[] = PeopleDirectory.OWNER_SEED): string[] {
    return role === "owner" ? PeopleDirectory.owners(inUse, seed) : PeopleDirectory.requesters(inUse);
  }

  /** Trimmed, whitespace-collapsed, case-insensitively deduped (first spelling wins), no sentinels or blocked names, A to Z. */
  static merge(values: readonly (string | null | undefined)[]): string[] {
    const byKey = new Map<string, string>();
    for (const raw of values) {
      const name = PeopleDirectory.normalizeName(raw);
      const key = name.toLowerCase();
      if (!name || PeopleDirectory.isSentinel(name) || PeopleDirectory.NEVER_SUGGEST.has(key) || byKey.has(key)) continue;
      byKey.set(key, name);
    }
    return [...byKey.values()].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" }));
  }

  /** Case-insensitive substring filter (blank query keeps everything). */
  static filter(options: readonly string[], query: string): string[] {
    const q = PeopleDirectory.normalizeName(query).toLowerCase();
    return q ? options.filter((n) => n.toLowerCase().includes(q)) : [...options];
  }

  /** Name matching the typed text exactly, ignoring case, or undefined. */
  static find(options: readonly string[], query: string): string | undefined {
    const key = PeopleDirectory.normalizeName(query).toLowerCase();
    return key ? options.find((n) => n.toLowerCase() === key) : undefined;
  }

  /** The normalized name to offer as "Add 'X'", or null (blank, sentinel, blocked, too long, or already listed). */
  static addCandidate(options: readonly string[], query: string): string | null {
    const name = PeopleDirectory.normalizeName(query);
    if (!name || PeopleDirectory.isSentinel(name) || PeopleDirectory.isBlocked(name) || name.length > PeopleDirectory.NAME_MAX) return null;
    return PeopleDirectory.find(options, name) ? null : name;
  }

  /** Split a name around the first case-insensitive occurrence of the typed text. */
  static segments(name: string, query: string): NameSegment[] {
    const q = PeopleDirectory.normalizeName(query).toLowerCase();
    const at = q ? name.toLowerCase().indexOf(q) : -1;
    if (at < 0) return [{ text: name, match: false }];
    return [
      { text: name.slice(0, at), match: false },
      { text: name.slice(at, at + q.length), match: true },
      { text: name.slice(at + q.length), match: false },
    ].filter((s) => s.text !== "");
  }

  /**
   * Server-side check for a name saved from the combobox: normalized, "To assign" text becomes blank,
   * and anything over NAME_MAX is an error. Not applicable text passes through for the requester
   * (Requester.normalizePatch turns it into the Not applicable state) and is blank for the owner.
   */
  static validateName(role: PeopleRole, raw: string): { ok: true; name: string } | { ok: false; error: string } {
    const name = PeopleDirectory.normalizeName(raw);
    if (PeopleDirectory.isToAssignText(name)) return { ok: true, name: "" };
    if (role === "owner" && PeopleDirectory.isNotApplicableText(name)) return { ok: true, name: "" };
    if (name.length > PeopleDirectory.NAME_MAX) {
      const label = role === "owner" ? "Owner" : "Requester";
      return { ok: false, error: `${label} must be at most ${PeopleDirectory.NAME_MAX} characters` };
    }
    return { ok: true, name };
  }

  private static key(raw: string | null | undefined): string {
    return PeopleDirectory.normalizeName(raw).toLowerCase();
  }
}
