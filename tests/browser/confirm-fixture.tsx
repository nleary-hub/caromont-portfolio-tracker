import { useState } from "react";
import { AiActionReview } from "../../src/components/AiActionReview";
import { AiActionReviewState } from "../../src/lib/ai/actions/AiActionReviewState";

// ?confirm=<px>: the confirm card (review-then-apply) inside a container of that width, as the project drawer (440px)
// and the command bar popover put it. Fictional projects and values only; apply and reject are no-op fakes.
if (new URLSearchParams(window.location.search).has("confirm"))
  (globalThis as unknown as { __fixtureActions: Record<string, (...a: never[]) => unknown> }).__fixtureActions = {
    applyAiActions: (async (_id: string, which: number[] | "all") => ({ ok: true, applied: (which === "all" ? [0, 1] : which).map((line) => ({ line })), failed: [] })) as never,
    rejectAiActions: (async () => ({ ok: true })) as never,
  };

const LONG = "Vendor returned the enclosure redlines on Oct 12 and the sample pilot wrapped up; the signed copy is due by the 23rd with a reference of EXAMPLE-ENCLOSURE-REDLINE-REVISION-0000000000000042.";
const initial = AiActionReviewState.of({
  proposalId: "fictional-confirm",
  summary: "2 changes to Example Kiosk Rollout",
  lines: [
    { line: 0, op: "set_field", projectId: "fictional-1", projectName: "Example Kiosk Rollout", label: "Latest update", before: "Pilot underway; enclosure quote still out.", after: LONG, reason: "\"from your quick capture\"" },
    { line: 1, op: "add_blocker" as never, projectId: "fictional-1", projectName: "Example Kiosk Rollout", label: "Add blocker", before: "", after: "Waiting on Example IT Security: kiosk network review, follow up 2026-10-24", reason: "\"waiting on Example IT Security\"" },
  ],
});

export function ConfirmFixture({ width }: { width: number }) {
  const [review, setReview] = useState(initial);
  return (
    <main className="p-4">
      <div style={{ width }} className="rounded-card border border-line bg-card p-3" data-testid="confirm-host">
        <AiActionReview review={review} from="fixture" onChange={setReview} />
      </div>
    </main>
  );
}
