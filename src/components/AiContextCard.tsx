"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { addGlossaryTerm, removeGlossaryTerm, setAiRoleTitle, setGlossaryDefinition } from "@/app/actions/aiContext";
import type { GlossaryView } from "@/lib/services/AiGlossaryService";
import { AutoGrowTextarea } from "./AutoGrowTextarea";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const INPUT = `h-7 w-full min-w-0 rounded-control border border-line bg-input px-2.5 text-fg type-table focus:border-accent disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`;
/** A definition grows with its text up to 4 lines (4 x 16px + 8px padding + 2px border), then scrolls (Figma Bro, Oct 18). */
const AREA = `block max-h-[74px] min-h-7 w-full min-w-0 resize-none rounded-control border border-line bg-input px-2.5 py-1 text-fg type-table focus:border-accent disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`;
/** The New term box takes the free width and shrinks, so Add term stays on the row inside the card at 880px. */
const NEW_TERM = `h-7 min-w-0 flex-1 rounded-control border border-line bg-input px-2.5 text-fg type-table focus:border-accent disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`;
const GHOST = `h-7 shrink-0 rounded-control border border-line px-3 text-fg type-table-strong hover:border-accent disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS}`;
const LINK = `h-7 shrink-0 rounded-control px-2 text-muted type-table hover:bg-white/5 hover:text-fg disabled:cursor-not-allowed disabled:opacity-40 ${FOCUS}`;

export const AiContextCopy = {
  TITLE: "Context",
  INTRO: "Every AI feature gets your name and role, today's date, the service line and this glossary, plus the full project context (people, milestones, history, blockers and computed flags).",
  ROLE_LABEL: "Your role title",
  ROLE_PLACEHOLDER: "e.g. Director of a service line",
  GLOSSARY_LABEL: "Glossary",
  GLOSSARY_HINT: "Terms the AI should know. A term with no definition is sent as a name only.",
  DEFINITION_PLACEHOLDER: "Write a definition",
  ADD_PLACEHOLDER: "New term",
  ADD: "Add term",
  SAVE: "Save",
  REMOVE: "Remove",
  SAVED: "Saved.",
} as const;

/** Admin > AI settings > Context (Tracker AI overhaul item A): role title and the org glossary. */
export function AiContextCard({ view, dbReady }: { view: GlossaryView; dbReady: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [role, setRole] = useState(view.roleTitle);
  const [defs, setDefs] = useState<Record<string, string>>(Object.fromEntries(view.terms.map((t) => [t.id, t.definition])));
  const [term, setTerm] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = (fn: () => Promise<{ ok: true } | { ok: false; error: string }>, after?: () => void) =>
    start(async () => {
      const r = await fn();
      setMsg(r.ok ? { ok: true, text: AiContextCopy.SAVED } : { ok: false, text: r.error });
      if (r.ok) {
        after?.();
        router.refresh();
      }
    });
  const off = !dbReady || pending;
  return (
    <div className="flex flex-col gap-3" data-testid="ai-context">
      <div>
        <h2 id="ai-context-heading" className="type-heading">
          {AiContextCopy.TITLE}
        </h2>
        <p className="mt-0.5 text-muted type-caption">{AiContextCopy.INTRO}</p>
      </div>
      <label className="flex flex-col gap-1">
        <span className="text-muted type-label">{AiContextCopy.ROLE_LABEL}</span>
        <span className="flex items-center gap-2">
          <input className={INPUT} value={role} maxLength={120} placeholder={AiContextCopy.ROLE_PLACEHOLDER} disabled={off} onChange={(e) => setRole(e.target.value)} data-testid="ai-role-title" />
          <button type="button" className={GHOST} disabled={off || role === view.roleTitle} onClick={() => run(() => setAiRoleTitle(role))} data-testid="ai-role-save">
            {AiContextCopy.SAVE}
          </button>
        </span>
      </label>
      <div className="flex flex-col gap-1">
        <span className="text-muted type-label">{AiContextCopy.GLOSSARY_LABEL}</span>
        <span className="text-muted type-caption">{AiContextCopy.GLOSSARY_HINT}</span>
        <ul className="flex flex-col divide-y divide-line rounded-control border border-line bg-white/[0.02]" data-testid="ai-glossary">
          {view.terms.map((t) => (
            <li key={t.id} className="flex min-w-0 items-start gap-2 px-3 py-2" data-testid="ai-glossary-row">
              <span className="w-40 shrink-0 pt-1 type-table-strong text-fg">{t.term}</span>
              <AutoGrowTextarea className={AREA} style={{ overflow: "auto" }} rows={1} maxLength={500} value={defs[t.id] ?? ""} placeholder={AiContextCopy.DEFINITION_PLACEHOLDER} disabled={off} onChange={(e) => setDefs({ ...defs, [t.id]: e.target.value })} aria-label={`Definition of ${t.term}`} />
              <button type="button" className={GHOST} disabled={off || (defs[t.id] ?? "") === t.definition} onClick={() => run(() => setGlossaryDefinition(t.id, defs[t.id] ?? ""))}>
                {AiContextCopy.SAVE}
              </button>
              <button type="button" className={LINK} disabled={off} onClick={() => run(() => removeGlossaryTerm(t.id))}>
                {AiContextCopy.REMOVE}
              </button>
            </li>
          ))}
          <li className="flex min-w-0 items-center gap-2 px-3 py-2">
            <input className={NEW_TERM} value={term} maxLength={60} placeholder={AiContextCopy.ADD_PLACEHOLDER} disabled={off} onChange={(e) => setTerm(e.target.value)} data-testid="ai-glossary-new" />
            <button type="button" className={GHOST} disabled={off || !term.trim()} onClick={() => run(() => addGlossaryTerm(term, ""), () => setTerm(""))} data-testid="ai-glossary-add">
              {AiContextCopy.ADD}
            </button>
          </li>
        </ul>
      </div>
      {msg && (
        <p className={`type-caption ${msg.ok ? "text-muted" : "text-danger"}`} role="status">
          {msg.text}
        </p>
      )}
    </div>
  );
}
