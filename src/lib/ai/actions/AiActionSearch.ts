import { PortfolioContext, type ContextProject } from "@/lib/ai/context/PortfolioContext";
import { ProjectStatusInfo } from "@/lib/domain/ProjectStatusInfo";

export interface AiSearchHit {
  ref: string;
  name: string;
  req: string | null;
  status: string;
  department: string | null;
  owner: string | null;
  /** What matched, in words ("REQ number", "waiting on Cortex Medical"). */
  matched: string;
}

type Filters = { status?: string; department?: string; owner?: string; overdue?: boolean; blocked?: boolean };

const norm = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9#]+/g, " ").trim();

/**
 * Item B: search_projects and get_project over the shared context (pure, unit tested). Fuzzy match on name, REQ number,
 * vendor (who an outside blocker waits on), department and owner. Filters narrow by status, department, owner,
 * overdue and blocked.
 */
export class AiActionSearch {
  static readonly MAX_HITS = 10;

  /** Score of one project for the query: higher is better, 0 = no match. */
  static score(p: ContextProject, query: string): { score: number; matched: string } {
    const q = norm(query);
    if (!q) return { score: 1, matched: "" };
    const req = /(?:req[\s#-]*)?(\d{3,6})/i.exec(query);
    if (req && p.reqNumber !== null && String(p.reqNumber) === req[1]) return { score: 100, matched: "REQ number" };
    const name = norm(p.name);
    if (name === q) return { score: 90, matched: "name" };
    if (name.includes(q)) return { score: 70, matched: "name" };
    const words = q.split(" ").filter((w) => w.length > 1);
    const nameWords = new Set(name.split(" "));
    const hit = words.filter((w) => nameWords.has(w) || [...nameWords].some((n) => n.startsWith(w) && w.length >= 3)).length;
    const vendor = p.external.find((b) => norm(b.waitingOn).includes(q) || words.some((w) => w.length >= 3 && norm(b.waitingOn).split(" ").includes(w)));
    if (vendor) return { score: 60, matched: `waiting on ${vendor.waitingOn}` };
    if (hit && hit === words.length) return { score: 50 + hit, matched: "name" };
    if (p.department && norm(p.department) === q) return { score: 40, matched: "department" };
    if (p.owner && (norm(p.owner) === q || norm(p.owner).split(" ").includes(q))) return { score: 35, matched: "owner" };
    if (hit) return { score: 10 + hit, matched: "name" };
    return { score: 0, matched: "" };
  }

  private static passes(p: ContextProject, f: Filters): boolean {
    if (f.status && norm(ProjectStatusInfo.label(p.status)) !== norm(f.status) && norm(p.status) !== norm(f.status)) return false;
    if (f.department && norm(p.department) !== norm(f.department)) return false;
    if (f.owner && !norm(p.owner).includes(norm(f.owner))) return false;
    if (f.overdue && !p.signals.overdue) return false;
    if (f.blocked && !p.blockedBy.length && !p.external.length) return false;
    return true;
  }

  static run(projects: readonly ContextProject[], query: string, rawFilters?: unknown): AiSearchHit[] {
    const f: Filters = rawFilters && typeof rawFilters === "object" ? (rawFilters as Filters) : {};
    return projects
      .map((p, i) => ({ p, i, ...AiActionSearch.score(p, query) }))
      .filter((x) => x.score > 0 && AiActionSearch.passes(x.p, f))
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .slice(0, AiActionSearch.MAX_HITS)
      .map(({ p, i, matched }) => ({ ref: PortfolioContext.ref(i), name: p.name, req: p.reqNumber !== null ? `REQ-${p.reqNumber}` : null, status: ProjectStatusInfo.label(p.status), department: p.department, owner: p.owner, matched }));
  }

  /** Everything the context knows about one project, nothing cut. */
  static detail(p: ContextProject, i: number): Record<string, unknown> {
    return PortfolioContext.project(p, i, { priorUpdates: PortfolioContext.PRIOR_UPDATES, descriptionCap: null, doneMilestones: true, updateCap: null });
  }
}
