import type { TemplateDto } from "@/lib/services/MilestoneTemplateService";

/** One checklist step of a project in the line, as the evidence reads it. */
export interface AiTemplateStepFact {
  projectId: string;
  name: string;
  sourceTemplateId: string | null;
}

/** What the line's real checklists show, counted in code (item 10). Counts are distinct projects. */
export interface AiTemplateEvidenceFacts {
  /** Projects counted: those using the template (edit) or every project with a checklist (draft). */
  projects: number;
  /** Edit: template steps few of those projects kept (dropped or renamed), with how many kept them. */
  dropped: { name: string; kept: number }[];
  /** Steps projects use that the template does not have (edit: added by hand; draft: common across the line). */
  common: { name: string; count: number }[];
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * Item 10 (Template AI assistant, grounded on real data): mines the line's project checklists (project_milestones)
 * so Draft and Edit with AI suggest what projects actually do, not only what the admin typed. Pure: the service reads
 * the rows, this counts them. Names are the projects' own step names (most used spelling).
 */
export class AiTemplateEvidence {
  /** A step counts as "common" when this many projects have it. */
  static readonly MIN_PROJECTS = 2;
  static readonly MAX_COMMON = 15;
  static readonly MAX_DROPPED = 10;

  /** The most used spelling of each normalized name, and the distinct projects that have it. */
  private static tally(steps: readonly AiTemplateStepFact[]): Map<string, { name: string; projects: Set<string> }> {
    const byKey = new Map<string, { spellings: Map<string, number>; projects: Set<string> }>();
    for (const s of steps) {
      const k = norm(s.name);
      if (!k) continue;
      const e = byKey.get(k) ?? { spellings: new Map(), projects: new Set() };
      e.spellings.set(s.name.trim(), (e.spellings.get(s.name.trim()) ?? 0) + 1);
      e.projects.add(s.projectId);
      byKey.set(k, e);
    }
    const out = new Map<string, { name: string; projects: Set<string> }>();
    for (const [k, e] of byKey) out.set(k, { name: [...e.spellings].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0], projects: e.projects });
    return out;
  }

  private static ranked(t: Map<string, { name: string; projects: Set<string> }>, skip: ReadonlySet<string>, max: number) {
    return [...t]
      .filter(([k, e]) => !skip.has(k) && e.projects.size >= AiTemplateEvidence.MIN_PROJECTS)
      .map(([, e]) => ({ name: e.name, count: e.projects.size }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, max);
  }

  /** Edit: the projects whose steps came from this template. null when no project uses it yet. */
  static forTemplate(current: TemplateDto, steps: readonly AiTemplateStepFact[]): AiTemplateEvidenceFacts | null {
    const users = new Set(steps.filter((s) => s.sourceTemplateId === current.id).map((s) => s.projectId));
    if (!users.size) return null;
    const mine = steps.filter((s) => users.has(s.projectId));
    const t = AiTemplateEvidence.tally(mine);
    const items = new Set(current.items.map((i) => norm(i.name)));
    const dropped = current.items
      .map((i) => ({ name: i.name, kept: t.get(norm(i.name))?.projects.size ?? 0 }))
      .filter((d) => d.kept * 2 < users.size)
      .slice(0, AiTemplateEvidence.MAX_DROPPED);
    return { projects: users.size, dropped, common: AiTemplateEvidence.ranked(t, items, AiTemplateEvidence.MAX_COMMON) };
  }

  /** Draft: steps that recur across the line's projects (any template or none). null when there is nothing to show. */
  static forDraft(steps: readonly AiTemplateStepFact[]): AiTemplateEvidenceFacts | null {
    const projects = new Set(steps.map((s) => s.projectId)).size;
    const common = AiTemplateEvidence.ranked(AiTemplateEvidence.tally(steps), new Set(), AiTemplateEvidence.MAX_COMMON);
    return common.length ? { projects, dropped: [], common } : null;
  }

  /** The block the model gets (between <evidence> tags). Counts only; no project names, people or dates. */
  static text(mode: "draft" | "edit", e: AiTemplateEvidenceFacts): string {
    const lines: string[] = [];
    if (mode === "edit") {
      lines.push(`Projects whose milestones came from this template: ${e.projects}`);
      if (e.dropped.length) lines.push("Template steps most of those projects dropped or renamed:", ...e.dropped.map((d) => `- ${d.name} (kept in ${d.kept} of ${e.projects})`));
      if (e.common.length) lines.push("Steps those projects added by hand (not in the template):", ...e.common.map((c) => `- ${c.name} (in ${c.count} of ${e.projects})`));
    } else {
      lines.push(`Projects in this line with a milestone checklist: ${e.projects}`);
      lines.push("Milestones that recur across those projects:", ...e.common.map((c) => `- ${c.name} (in ${c.count} projects)`));
    }
    return lines.join("\n");
  }
}
