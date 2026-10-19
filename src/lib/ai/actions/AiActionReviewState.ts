import type { AiActionLine } from "./AiActionModel";

/** Item C: the confirm card state (voice chat, the command bar): one status per proposal line. */
export type AiActionLineStatus = { status: "open" | "applied" | "rejected" | "undone"; error?: string };
export type AiActionReviewState = { proposalId: string; summary: string; lines: AiActionLine[]; status: Record<number, AiActionLineStatus> };

export const AiActionReviewState = {
  of(p: { proposalId: string; summary: string; lines: AiActionLine[] }): AiActionReviewState {
    return { ...p, status: Object.fromEntries(p.lines.map((l) => [l.line, { status: "open" as const }])) };
  },
  /** Folds an apply result (from the Apply buttons or the voice apply_changes tool) into the line states. */
  applied(s: AiActionReviewState, applied: readonly { line: number }[], failed: readonly { line: number; message: string }[] = []): AiActionReviewState {
    const status = { ...s.status };
    for (const a of applied) status[a.line] = { status: "applied" };
    for (const f of failed) status[f.line] = { status: status[f.line]?.status ?? "open", error: f.message };
    return { ...s, status };
  },
};
