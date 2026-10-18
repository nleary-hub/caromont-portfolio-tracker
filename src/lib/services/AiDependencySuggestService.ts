import type { Viewer } from "@/lib/auth/AdminPolicy";
import { AiCopy } from "@/lib/ai/AiCopy";
import { AiToolsCopy } from "@/lib/ai/AiToolsCopy";
import type { AiActionLine, AiActionRefusal } from "@/lib/ai/actions/AiActionModel";
import { AiDependencySuggestModel } from "@/lib/ai/deps/AiDependencySuggestModel";
import type { ServiceLineScope } from "@/lib/domain/ServiceLine";
import { AiActionService, type AiActionDb } from "@/lib/services/AiActionService";
import type { AiProviderKeySource } from "@/lib/services/AiFeatureProviderService";
import { AiToolsService } from "@/lib/services/AiToolsService";

type Env = Record<string, string | undefined>;
type FetchLike = typeof fetch;

export type AiDependencySuggestResult =
  | { ok: true; checked: number; proposal: { proposalId: string; lines: AiActionLine[]; summary: string } | null; refused: AiActionRefusal[]; message: string | null }
  | { ok: false; message: string };

const ALREADY = /\bis already\b|\balready (done|an open)\b/;

/**
 * Item 8: AI blocker suggestions inside Dependencies. One project (drawer) or the whole line (Admin > Dependencies,
 * the one-time seed pass). Runs on the related_links toggle and route ("Dependency suggestions"); every line goes
 * through AiActionService.propose, so direction, cycles and duplicates are checked like a manual add, and nothing is
 * created until Apply on the confirm card.
 */
export class AiDependencySuggestService {
  static readonly FEATURE = "related_links" as const;

  static async suggest(args: { db: AiActionDb; viewer: Viewer | null; scope: ServiceLineScope; projectId?: unknown; env?: Env; fetchImpl?: FetchLike; keys?: AiProviderKeySource; now?: () => Date }): Promise<AiDependencySuggestResult> {
    if (!args.viewer?.isAdmin) return { ok: false, message: AiCopy.NOT_AUTHORIZED };
    const only = typeof args.projectId === "string" && args.projectId ? args.projectId : null;
    if (only && !/^[0-9a-f-]{36}$/i.test(only)) return { ok: false, message: AiToolsCopy.PICK_PROJECT };
    const projects = await AiToolsService.projects(args.db, args.scope);
    if (only && !projects.some((p) => p.id === only)) return { ok: false, message: AiCopy.PROJECT_GONE };
    const candidates = AiDependencySuggestModel.scan(projects, only);
    if (!candidates.length) return { ok: true, checked: 0, proposal: null, refused: [], message: AiToolsCopy.DEPS_NOTHING_TO_CHECK };
    const context = await AiToolsService.contextFor(args.db, args.scope, args.viewer, projects, args.now);
    const r = await AiToolsService.call({
      db: args.db,
      viewer: args.viewer,
      feature: AiDependencySuggestService.FEATURE,
      projectId: only,
      input: AiDependencySuggestModel.user(candidates),
      build: (input) => ({ system: AiDependencySuggestModel.system(context), user: input, maxTokens: AiDependencySuggestModel.MAX_TOKENS }),
      env: args.env,
      fetchImpl: args.fetchImpl,
      keys: args.keys,
      now: args.now,
    });
    if (!r.ok) return { ok: false, message: r.message };
    const changes = AiDependencySuggestModel.parse(r.text, candidates);
    if (!changes) {
      await r.log("failed");
      return { ok: false, message: AiToolsCopy.PARSE_FAILED };
    }
    await r.log("suggested", { outputLength: null });
    if (!changes.length) return { ok: true, checked: candidates.length, proposal: null, refused: [], message: AiToolsCopy.DEPS_NONE_FOUND };
    const p = await AiActionService.propose({ db: args.db, viewer: args.viewer, scope: args.scope, projects, feature: AiDependencySuggestService.FEATURE, changes, env: args.env, now: args.now?.() });
    const refused = (p.ok ? p.refused : (p.refused ?? [])).filter((x) => !ALREADY.test(x.why));
    if (!p.ok) return { ok: true, checked: candidates.length, proposal: null, refused, message: refused.length ? p.message : AiToolsCopy.DEPS_NONE_FOUND };
    return { ok: true, checked: candidates.length, proposal: { proposalId: p.proposalId, lines: p.lines, summary: p.summary }, refused, message: null };
  }
}
