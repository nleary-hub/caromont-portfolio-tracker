import { AiActionReviewState } from "../actions/AiActionReviewState";
import type { AiActionLine } from "../actions/AiActionModel";
import type { AiCommandTurn } from "./AiCommandModel";

/** One entry of the command bar's running conversation (kept in the browser only, never stored). */
export type AiCommandEntry =
  | { kind: "user"; text: string }
  | { kind: "ai"; text: string; error?: boolean }
  | { kind: "review"; review: AiActionReviewState }
  | { kind: "draft"; proposalId: string; draft: unknown };

type Result =
  | {
      ok: true;
      say: string;
      proposals: { proposalId: string; lines: AiActionLine[]; summary: string }[];
      drafts: { proposalId: string; draft: unknown }[];
      applied: { proposalId: string; applied: { line: number }[]; failed: { line: number; message: string }[] }[];
    }
  | { ok: false; message: string };

const STATUS: Record<string, string> = { applied: "applied", rejected: "rejected", undone: "undone" };

/** Voice and command bar item: the command bar conversation's pure rules (what to send, how a reply lands). */
export const AiCommandConversation = {
  /** The turns sent to the server: people's lines, the AI's answers, and each proposal (with what was decided) on the answer it belongs to. */
  turns(entries: readonly AiCommandEntry[]): AiCommandTurn[] {
    const out: AiCommandTurn[] = [];
    for (const e of entries) {
      if (e.kind === "user") out.push({ role: "user", text: e.text });
      else if (e.kind === "ai" && !e.error) out.push({ role: "assistant", text: e.text });
      else if (e.kind === "review") {
        const decided = Object.values(e.review.status)
          .map((s) => STATUS[s.status])
          .filter(Boolean);
        const summary = decided.length ? `${e.review.summary} (${decided.length} of ${e.review.lines.length} lines ${[...new Set(decided)].join(" or ")})` : e.review.summary;
        let last = out.at(-1);
        if (!last || last.role !== "assistant") out.push((last = { role: "assistant", text: "" }));
        last.proposals = [...(last.proposals ?? []), { proposalId: e.review.proposalId, summary }];
      }
    }
    return out;
  },

  /** The conversation after one message and its reply: the answer, then any new cards; an apply by "yes" updates its card. */
  fold(entries: readonly AiCommandEntry[], result: Result): AiCommandEntry[] {
    if (!result.ok) return [...entries, { kind: "ai", text: result.message, error: true }];
    const next = entries.map((e) => {
      if (e.kind !== "review") return e;
      const a = result.applied.find((x) => x.proposalId === e.review.proposalId);
      return a ? { kind: "review" as const, review: AiActionReviewState.applied(e.review, a.applied, a.failed) } : e;
    });
    return [
      ...next,
      { kind: "ai", text: result.say },
      ...result.proposals.map((p) => ({ kind: "review" as const, review: AiActionReviewState.of(p) })),
      ...result.drafts.map((d) => ({ kind: "draft" as const, proposalId: d.proposalId, draft: d.draft })),
    ];
  },

  /** A review card changed by its own buttons. */
  update(entries: readonly AiCommandEntry[], review: AiActionReviewState): AiCommandEntry[] {
    return entries.map((e) => (e.kind === "review" && e.review.proposalId === review.proposalId ? { kind: "review", review } : e));
  },
};
