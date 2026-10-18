import type { Viewer } from "@/lib/auth/AdminPolicy";
import { AiCopy } from "@/lib/ai/AiCopy";
import { AiToolsCopy } from "@/lib/ai/AiToolsCopy";
import type { AiToolProject } from "@/lib/ai/AiToolsModel";
import type { AiActionLine } from "@/lib/ai/actions/AiActionModel";
import { AiCommandModel } from "@/lib/ai/command/AiCommandModel";
import type { ServiceLineScope } from "@/lib/domain/ServiceLine";
import { AiActionService, type AiActionDb, type AiActionPorts } from "@/lib/services/AiActionService";
import type { AiProviderKeySource } from "@/lib/services/AiFeatureProviderService";
import { AiToolsService, type AiToolUsageRow } from "@/lib/services/AiToolsService";

type Env = Record<string, string | undefined>;
type FetchLike = typeof fetch;

export type AiCommandProposal = { proposalId: string; lines: AiActionLine[]; summary: string };
export type AiCommandResult =
  | {
      ok: true;
      say: string;
      proposals: AiCommandProposal[];
      drafts: { proposalId: string; draft: unknown }[];
      applied: { proposalId: string; applied: { line: number }[]; failed: { line: number; message: string }[] }[];
      changed: boolean;
    }
  | { ok: false; message: string };

/**
 * Voice and command bar item: one typed message to the command bar. The same assistant as voice chat over the shared
 * action tools (item B), run as the quick_capture feature with its routed model (item D). The model may call tools for
 * up to MAX_ROUNDS rounds; proposals come back as confirm cards, and apply_changes runs only after the person's latest
 * message is a clear yes (checked here, not just asked of the model). One run row per message carries the summed
 * tokens, latency and cost; proposals are the action layer's own rows. Never touches snapshots, PDFs or handoff.json.
 */
export class AiCommandService {
  static readonly FEATURE = "quick_capture" as const;

  static async run(args: {
    db: AiActionDb;
    viewer: Viewer | null;
    scope: ServiceLineScope;
    turns: unknown;
    projects: readonly AiToolProject[];
    ports: AiActionPorts;
    env?: Env;
    fetchImpl?: FetchLike;
    keys?: AiProviderKeySource;
    now?: () => Date;
  }): Promise<AiCommandResult> {
    if (!args.viewer?.isAdmin) return { ok: false, message: AiCopy.NOT_AUTHORIZED };
    const turns = AiCommandModel.turns(args.turns);
    if (!turns) return { ok: false, message: AiToolsCopy.COMMAND_EMPTY };
    const lastUser = turns.at(-1)!.text;
    const context = await AiToolsService.contextFor(args.db, args.scope, args.viewer, args.projects, args.now);
    const system = AiCommandModel.system(context);

    const results: { name: string; output: string }[] = [];
    const proposals: AiCommandProposal[] = [];
    const drafts: { proposalId: string; draft: unknown }[] = [];
    const applied: { proposalId: string; applied: { line: number }[]; failed: { line: number; message: string }[] }[] = [];
    let changed = false;
    const sum = { latencyMs: 0, inputTokens: null as number | null, outputTokens: null as number | null, costUsd: null as number | null };
    const add = (run: Partial<AiToolUsageRow>) => {
      sum.latencyMs += run.latencyMs ?? 0;
      if (typeof run.inputTokens === "number") sum.inputTokens = (sum.inputTokens ?? 0) + run.inputTokens;
      if (typeof run.outputTokens === "number") sum.outputTokens = (sum.outputTokens ?? 0) + run.outputTokens;
      if (typeof run.costUsd === "number") sum.costUsd = Math.round(((sum.costUsd ?? 0) + run.costUsd) * 1e6) / 1e6;
    };

    let say = "";
    let log: ((event: string, extra?: Partial<AiToolUsageRow>) => Promise<unknown>) | null = null;
    for (let round = 0; round < AiCommandModel.MAX_ROUNDS; round++) {
      const r = await AiToolsService.call({
        db: args.db,
        viewer: args.viewer,
        feature: AiCommandService.FEATURE,
        input: AiCommandModel.user(turns, results),
        build: (input) => ({ system, user: input, maxTokens: AiCommandModel.MAX_TOKENS }),
        env: args.env,
        fetchImpl: args.fetchImpl,
        keys: args.keys,
        now: args.now,
      });
      // A failed call already wrote its failed run row. Earlier rounds' cards stay usable.
      if (!r.ok) return proposals.length || drafts.length || applied.length ? { ok: true, say: r.message, proposals, drafts, applied, changed } : { ok: false, message: r.message };
      add(r.run);
      log = r.log;
      const reply = AiCommandModel.parse(r.text);
      if (!reply) {
        say = AiToolsCopy.COMMAND_UNREADABLE;
        break;
      }
      say = reply.say;
      if (!reply.calls.length) break;
      for (const call of reply.calls) {
        if (call.name === "apply_changes" && !AiCommandModel.isYes(lastUser)) {
          results.push({ name: call.name, output: JSON.stringify({ ok: false, error: AiCommandModel.NEEDS_YES }) });
          continue;
        }
        if (call.name === "undo_last_apply" && !/\bundo\b/i.test(lastUser)) {
          results.push({ name: call.name, output: JSON.stringify({ ok: false, error: "Not undone: the person did not ask to undo." }) });
          continue;
        }
        const t = await AiActionService.runTool({ name: call.name, args: call.arguments, db: args.db, viewer: args.viewer, scope: args.scope, feature: AiCommandService.FEATURE, source: "command", projects: args.projects, ports: args.ports, env: args.env, now: args.now });
        results.push({ name: call.name, output: t.output });
        if (t.proposal) proposals.push(t.proposal);
        if (t.draft) drafts.push(t.draft);
        if (t.changed) changed = true;
        if (call.name === "apply_changes") {
          const o = JSON.parse(t.output) as { ok?: boolean; applied?: { line: number }[]; failed?: { line: number; message: string }[] };
          if (o.ok) applied.push({ proposalId: String(call.arguments.proposalId ?? ""), applied: o.applied ?? [], failed: o.failed ?? [] });
        }
      }
      // Tools ran: one more round so the model can answer from the results (the last round's say is used as is).
      if (round === AiCommandModel.MAX_ROUNDS - 1 && !say) say = AiToolsCopy.COMMAND_TOO_MANY;
    }
    if (log) await log("suggested", { ...sum, outputLength: null, inputLength: lastUser.length });
    return { ok: true, say: say || (proposals.length ? `${proposals.at(-1)!.summary}. Apply?` : AiToolsCopy.COMMAND_UNREADABLE), proposals, drafts, applied, changed };
  }
}
