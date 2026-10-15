"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { confirmAiRelatedLink, proposeAiRelatedLinks, rejectAiToolLine, removeRelatedLink } from "@/app/actions/aiTools";
import { AiAlert } from "@/components/AiNoteAssistant";
import { AiToolsCopy as C } from "@/lib/ai/AiToolsCopy";
import type { AiLinkSuggestion } from "@/lib/ai/AiToolsModel";
import type { AiRelatedLinkView } from "@/lib/services/AiToolsService";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const PRIMARY = `h-8 whitespace-nowrap rounded-control btn-primary bg-accent-strong px-3.5 text-white type-table-strong disabled:cursor-not-allowed disabled:bg-(--status-not-started-dark-bg) disabled:text-muted ${FOCUS}`;
const GHOST = `h-7 whitespace-nowrap rounded-control border border-line px-3 text-fg type-table-strong hover:border-accent disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`;

export type AiLinksState = { kind: "idle" } | { kind: "error"; message: string } | { kind: "review"; proposalId: string; links: AiLinkSuggestion[] };
type LineStatus = { status: "open" | "applied" | "rejected"; error?: string };

const ProjectLink = ({ id, name }: { id: string; name: string }) => (
  <Link href={`/?project=${id}`} className="type-table-strong text-accent hover:underline">
    {name}
  </Link>
);

/** Step 9: suggested related-project links, each added only when a person clicks Link, plus the confirmed list. */
export function AiLinksPanel({ disabledNote, saved, initial }: { disabledNote: string | null; saved: AiRelatedLinkView[]; initial?: AiLinksState }) {
  const [state, setState] = useState<AiLinksState>(initial ?? { kind: "idle" });
  const [lines, setLines] = useState<Record<number, LineStatus>>({});
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();
  const off = disabledNote !== null;
  const set = (line: number, s: LineStatus) => setLines((l) => ({ ...l, [line]: s }));
  return (
    <div className="flex flex-col gap-3" data-testid="ai-tool-related_links">
      <p className="text-muted type-caption">{C.LINKS_HELP}</p>
      <div className="flex items-center gap-3">
        <button
          type="button"
          className={PRIMARY}
          disabled={off || pending}
          data-testid="ai-tool-related_links-propose"
          onClick={() =>
            start(async () => {
              const r = await proposeAiRelatedLinks("");
              setLines({});
              setState(r.ok ? { kind: "review", proposalId: r.proposalId, links: r.links } : { kind: "error", message: r.message });
            })
          }
        >
          {pending ? C.PROPOSING : C.LINKS_PROPOSE}
        </button>
        {off && <span className="text-muted type-caption">{disabledNote}</span>}
      </div>
      {state.kind === "error" && <AiAlert tone="danger" testId="ai-tool-links-error">{state.message}</AiAlert>}
      {state.kind === "review" &&
        (state.links.length === 0 ? (
          <p role="status" className="text-muted type-table">
            {C.LINKS_NONE}
          </p>
        ) : (
          <div role="region" aria-labelledby="ai-links-title" className="flex flex-col gap-2 rounded-card border border-line bg-input/60 p-3" data-testid="ai-tool-links-review">
            <div className="flex items-center gap-2">
              <h3 id="ai-links-title" className="type-table-strong text-fg">
                {C.LINKS_REVIEW_TITLE}
              </h3>
              <span className="rounded-pill bg-(--status-not-started-dark-bg) px-2 py-px text-(--status-not-started-dark-fg) type-label">{C.AI_LABEL}</span>
            </div>
            <div className="overflow-x-auto rounded-card border border-line">
              <table className="w-full type-table">
                <thead className="bg-card text-left text-muted type-label">
                  <tr>
                    {C.LINKS_HEADERS.map((h, i) => (
                      <th key={i} className="px-3 py-2 font-medium">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {state.links.map((l) => {
                    const s = lines[l.line] ?? { status: "open" };
                    return (
                      <tr key={l.line} className="border-t border-line align-top" data-testid={`ai-link-line-${l.line}`} data-status={s.status}>
                        <td className="px-3 py-2">
                          <ProjectLink id={l.aId} name={l.aName} />
                        </td>
                        <td className="px-3 py-2">
                          <ProjectLink id={l.bId} name={l.bName} />
                        </td>
                        <td className="px-3 py-2 text-muted">
                          {l.reason}
                          {s.error && (
                            <span role="alert" className="mt-1 block text-danger type-caption">
                              {s.error}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          {s.status === "open" ? (
                            <div className="flex gap-2">
                              <button type="button" className={GHOST} disabled={pending} data-testid={`ai-link-confirm-${l.line}`} onClick={() => start(async () => {
                                const r = await confirmAiRelatedLink(state.proposalId, l.line, l.aId, l.bId, l.reason);
                                set(l.line, r.ok ? { status: "applied" } : { status: "open", error: r.message });
                              })}>
                                {C.LINK_CONFIRM}
                              </button>
                              <button type="button" className={GHOST} disabled={pending} onClick={() => start(async () => {
                                const r = await rejectAiToolLine(state.proposalId, l.line);
                                set(l.line, r.ok ? { status: "rejected" } : { status: "open", error: r.message });
                              })}>
                                {C.REJECT}
                              </button>
                            </div>
                          ) : (
                            <span className={s.status === "applied" ? "text-(--status-on-track-dark-fg) type-table-strong" : "text-muted"}>{s.status === "applied" ? C.LINK_LINKED : C.REJECTED}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      <section className="flex flex-col gap-1" aria-labelledby="ai-links-saved-title" data-testid="ai-links-saved">
        <h3 id="ai-links-saved-title" className="type-table-strong text-fg">
          {C.LINKS_SAVED_TITLE}
        </h3>
        {saved.filter((s) => !removed.has(s.id)).length === 0 ? (
          <p className="text-muted type-table">{C.LINKS_SAVED_EMPTY}</p>
        ) : (
          <ul className="flex flex-col gap-1 type-table">
            {saved
              .filter((s) => !removed.has(s.id))
              .map((s) => (
                <li key={s.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <ProjectLink id={s.aId} name={s.aName} />
                  <span className="text-muted" aria-hidden="true">
                    and
                  </span>
                  <ProjectLink id={s.bId} name={s.bName} />
                  {s.reason && <span className="text-muted type-caption">({s.reason})</span>}
                  <button type="button" className={GHOST} disabled={pending} onClick={() => start(async () => {
                    const r = await removeRelatedLink(s.id);
                    if (r.ok) setRemoved((x) => new Set(x).add(s.id));
                  })}>
                    {C.LINK_REMOVE}
                  </button>
                </li>
              ))}
          </ul>
        )}
      </section>
    </div>
  );
}
