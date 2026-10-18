"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition, type ReactNode } from "react";
import { makeAiPlaybook } from "@/app/actions/aiPlaybook";
import { AiAlert } from "@/components/AiNoteAssistant";
import { AiToolsPanel } from "@/components/AiToolsPanel";
import { AiOffNote, pausedProps, TOOL_PRIMARY } from "@/components/AiToolsUi";
import { AiToolsCopy as C } from "@/lib/ai/AiToolsCopy";
import { AiPlaybookModel, type AiMeetingType, type AiPlaybookLength, type AiPlaybookRecord, type AiPlaybookRef, type AiPlaybookScope } from "@/lib/ai/playbook/AiPlaybookModel";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const GHOST = `h-7 whitespace-nowrap rounded-control border border-line px-3 text-fg type-table-strong hover:border-accent disabled:cursor-not-allowed disabled:opacity-50 ${FOCUS}`;
const FIELD = `h-8 rounded-control border border-line bg-input px-2.5 text-fg type-table ${FOCUS}`;
const CARD = "flex flex-col gap-2 rounded-card border border-line bg-card/80 p-4 backdrop-blur-[20px] print:border-0 print:bg-transparent print:p-0 print:backdrop-blur-none";

/** A project name that opens it on the dashboard (every claim links to its project). */
function P({ r }: { r: AiPlaybookRef }) {
  return (
    <Link href={`/?project=${r.id}`} className="type-table-strong text-accent hover:underline print:text-fg print:no-underline">
      {r.name}
    </Link>
  );
}

function Section({ n, children, testId }: { n: number; children: ReactNode; testId: string }) {
  const id = `pb-sec-${n}`;
  return (
    <section aria-labelledby={id} className={CARD} data-testid={testId}>
      <h2 id={id} className="type-heading">
        {n}. {C.PLAYBOOK_SECTIONS[n - 1]}
      </h2>
      {children}
    </section>
  );
}

const None = () => <p className="text-muted type-table">{C.PLAYBOOK_NONE}</p>;

/** The eight sections of one playbook, full width. */
export function AiPlaybookView({ record }: { record: AiPlaybookRecord }) {
  const p = record.content;
  const [copied, setCopied] = useState(false);
  const [email, setEmail] = useState(false);
  const text = AiPlaybookModel.text(record);
  const word = () => {
    const blob = new Blob([AiPlaybookModel.wordHtml(record)], { type: "application/msword" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `meeting-playbook-${record.createdAt.slice(0, 10)}.doc`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <article className="flex flex-col gap-3" aria-label={C.PLAYBOOK_TITLE} data-testid="ai-playbook">
      <div className={`${CARD} flex-row flex-wrap items-center gap-3`}>
        <div className="flex min-w-0 flex-col">
          <span className="type-table-strong text-fg">
            {AiPlaybookModel.meetingLabel(record.meetingType)} ({record.lengthMinutes} min)
          </span>
          <span className="text-muted type-caption">
            {record.scopeLabel}. {new Date(record.createdAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}
            {record.focus ? `. Focus: ${record.focus}` : ""}
          </span>
        </div>
        <div className="ml-auto flex flex-wrap gap-2 print:hidden">
          <button
            type="button"
            className={GHOST}
            onClick={async () => {
              await navigator.clipboard?.writeText(text);
              setCopied(true);
            }}
            data-testid="ai-playbook-copy"
          >
            {copied ? C.PLAYBOOK_COPIED : C.PLAYBOOK_COPY}
          </button>
          <button type="button" className={GHOST} onClick={() => window.print()} data-testid="ai-playbook-print">
            {C.PLAYBOOK_PRINT}
          </button>
          <button type="button" className={GHOST} onClick={word} data-testid="ai-playbook-word">
            {C.PLAYBOOK_WORD}
          </button>
          <button type="button" className={GHOST} aria-expanded={email} onClick={() => setEmail((v) => !v)} data-testid="ai-playbook-email">
            {C.PLAYBOOK_EMAIL}
          </button>
        </div>
        {email && <textarea readOnly value={text} rows={12} aria-label={C.PLAYBOOK_EMAIL} className={`w-full rounded-control border border-line bg-input p-2.5 font-mono text-fg type-caption print:hidden ${FOCUS}`} data-testid="ai-playbook-email-text" />}
      </div>

      <Section n={1} testId="ai-playbook-bottom-line">
        <p className="text-fg type-table">{p.bottomLine}</p>
      </Section>

      <Section n={2} testId="ai-playbook-decisions">
        {p.decisions.length ? (
          <ul className="flex flex-col gap-2">
            {p.decisions.map((d, i) => (
              <li key={i} className="type-table text-fg">
                <P r={d.project} />: {d.decision}
                <div className="text-muted type-caption">
                  Who decides: {d.who}. Ask: {d.ask || C.PLAYBOOK_NONE} If it slips: {d.ifSlips || "Not stated."}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <None />
        )}
      </Section>

      <Section n={3} testId="ai-playbook-agenda">
        {p.agenda.length ? (
          <ol className="flex flex-col gap-1.5">
            {p.agenda.map((a, i) => (
              <li key={i} className="type-table text-fg">
                <span className="type-table-strong">
                  {i + 1}. {a.title}
                </span>{" "}
                <span className="text-muted tabular-nums">({a.minutes} min)</span>
                {a.projects.length > 0 && (
                  <div className="flex flex-wrap gap-x-2 pl-4">
                    {a.projects.map((r) => (
                      <P key={r.id} r={r} />
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ol>
        ) : (
          <None />
        )}
      </Section>

      <Section n={4} testId="ai-playbook-talking-points">
        {p.talkingPoints.length ? (
          <div className="grid gap-2 md:grid-cols-2 print:grid-cols-1">
            {p.talkingPoints.map((t, i) => (
              <div key={i} className="flex flex-col gap-0.5 rounded-card border border-line bg-input/60 p-3 type-table print:border-0 print:p-0">
                <P r={t.project} />
                <span className="text-fg">{t.state}</span>
                <span className="text-muted">Changed: {t.changed}</span>
                <span className="text-muted">Blocker: {t.blocker}</span>
                <span className="text-muted">Owner: {t.owner}</span>
                <span className="text-fg">
                  Ask {t.askWho}: {t.question}
                </span>
                <span className="text-fg">
                  Next: {t.nextStep}
                  {t.nextDate ? ` by ${t.nextDate}` : ""}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <None />
        )}
      </Section>

      <Section n={5} testId="ai-playbook-watchlist">
        {p.watchlist.length ? (
          <ul className="flex flex-col gap-1">
            {p.watchlist.map((w) => (
              <li key={w.project.id} className="type-table text-fg">
                <P r={w.project} />: <span className="text-muted">{w.items.join("; ")}</span>
              </li>
            ))}
          </ul>
        ) : (
          <None />
        )}
      </Section>

      <Section n={6} testId="ai-playbook-dependencies">
        {p.dependencies.blockers.length + p.dependencies.parties.length + p.dependencies.patterns.length === 0 && <None />}
        <ul className="flex flex-col gap-1">
          {p.dependencies.blockers.map((b) => (
            <li key={b.project.id} className="type-table text-fg">
              <P r={b.project} /> ({b.status}) is holding up{" "}
              {b.blocking.map((x, i) => (
                <span key={x.id}>
                  {i ? ", " : ""}
                  <P r={x} />
                </span>
              ))}
            </li>
          ))}
          {p.dependencies.parties.map((g) => (
            <li key={g.party} className="type-table text-fg">
              <span className="type-table-strong">Waiting on {g.party}:</span> <span className="text-muted">{g.items.join("; ")}</span>
            </li>
          ))}
          {p.dependencies.patterns.map((x, i) => (
            <li key={i} className="type-table text-fg">
              {x.text}{" "}
              {x.projects.map((r) => (
                <span key={r.id} className="mr-2">
                  <P r={r} />
                </span>
              ))}
            </li>
          ))}
        </ul>
      </Section>

      <Section n={7} testId="ai-playbook-wins">
        {p.wins.length ? (
          <ul className="flex flex-col gap-1">
            {p.wins.map((w, i) => (
              <li key={i} className="type-table text-fg">
                <P r={w.project} />: {w.text}
              </li>
            ))}
          </ul>
        ) : (
          <None />
        )}
      </Section>

      <Section n={8} testId="ai-playbook-follow-ups">
        {p.followUps.length ? (
          <div className="overflow-x-auto rounded-card border border-line">
            <table className="w-full type-table">
              <thead className="bg-card text-left text-muted type-label">
                <tr>
                  {C.PLAYBOOK_FOLLOW_HEADERS.map((h) => (
                    <th key={h} className="px-3 py-2 font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {p.followUps.map((f, i) => (
                  <tr key={i} className="border-t border-line align-top">
                    <td className="px-3 py-1.5 text-fg">{f.action}</td>
                    <td className="px-3 py-1.5 text-fg">{f.owner}</td>
                    <td className="px-3 py-1.5 tabular-nums text-fg">{f.due ?? "No date"}</td>
                    <td className="px-3 py-1.5">{f.project ? <P r={f.project} /> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <None />
        )}
      </Section>
      <p className="text-muted type-caption">{C.PLAYBOOK_NOTE}</p>
    </article>
  );
}

/** Close the loop: the saved playbook's notes go through Meeting notes to updates with its follow-ups as context. */
export function AiPlaybookNotes({ record, disabledNote, dictationNote }: { record: AiPlaybookRecord; disabledNote: string | null; dictationNote?: string | null }) {
  const [open, setOpen] = useState(false);
  const prefix = AiPlaybookModel.notesPrefix(record);
  return (
    <section className={`${CARD} print:hidden`} aria-label={C.PLAYBOOK_PROCESS} data-testid="ai-playbook-notes">
      <div className="flex items-center gap-2">
        <button type="button" className={TOOL_PRIMARY} aria-expanded={open} {...pausedProps(disabledNote, "ai-playbook-notes-off")} onClick={() => !disabledNote && setOpen((v) => !v)} data-testid="ai-playbook-process">
          {C.PLAYBOOK_PROCESS}
        </button>
      </div>
      <AiOffNote id="ai-playbook-notes-off" note={disabledNote} testId="ai-playbook-notes-off-note" />
      {open && !disabledNote && <AiToolsPanel feature="meeting_notes" label={C.MEETING_LABEL} help={C.PLAYBOOK_PROCESS_HELP} placeholder={C.MEETING_PLACEHOLDER} disabledNote={null} rows={8} context={{ line: `${C.PLAYBOOK_TITLE}: ${record.scopeLabel}`, prefix }} {...(dictationNote !== undefined ? { dictation: { disabledNote: dictationNote } } : {})} />}
    </section>
  );
}

/** The form: meeting type, scope, length, focus. A made playbook is saved and opened (URL ?id=). */
export function AiPlaybookForm({ disabledNote, departments, owners, picked }: { disabledNote: string | null; departments: readonly string[]; owners: readonly string[]; picked: { ids: string[]; label: string } | null }) {
  const router = useRouter();
  const [type, setType] = useState<AiMeetingType>("biweekly_review");
  const [kind, setKind] = useState<AiPlaybookScope["kind"]>(picked ? "projects" : "line");
  const [dept, setDept] = useState(departments[0] ?? "");
  const [owner, setOwner] = useState(owners[0] ?? "");
  const [length, setLength] = useState<AiPlaybookLength>(30);
  const [focus, setFocus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const scope: AiPlaybookScope = kind === "department" ? { kind, value: dept } : kind === "owner" ? { kind, value: owner } : kind === "projects" && picked ? { kind, ids: picked.ids, label: picked.label } : { kind: "line" };
  const make = () =>
    start(async () => {
      setError(null);
      const r = await makeAiPlaybook({ meetingType: type, scope, length, focus });
      if (!r.ok) return setError(r.message);
      router.push(`/playbook?id=${r.playbook.id}`);
      router.refresh();
    });
  return (
    <section className={`${CARD} print:hidden`} aria-label={C.PLAYBOOK_NEW} data-testid="ai-playbook-form">
      <div className="grid gap-3 md:grid-cols-[2fr_1.5fr_auto]">
        <label className="flex min-w-0 flex-col gap-1">
          <span className="text-muted type-caption">{C.PLAYBOOK_TYPE}</span>
          <select className={FIELD} value={type} onChange={(e) => setType(e.target.value as AiMeetingType)} data-testid="ai-playbook-type">
            {AiPlaybookModel.MEETING_TYPES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <div className="flex min-w-0 flex-col gap-1">
          <label htmlFor="ai-playbook-scope" className="text-muted type-caption">
            {C.PLAYBOOK_SCOPE}
          </label>
          <div className="flex gap-2">
            <select id="ai-playbook-scope" className={`${FIELD} min-w-0 flex-1`} value={kind} onChange={(e) => setKind(e.target.value as AiPlaybookScope["kind"])} data-testid="ai-playbook-scope">
              <option value="line">{C.PLAYBOOK_SCOPE_LINE}</option>
              {departments.length > 0 && <option value="department">{C.PLAYBOOK_SCOPE_DEPT}</option>}
              {owners.length > 0 && <option value="owner">{C.PLAYBOOK_SCOPE_OWNER}</option>}
              {picked && <option value="projects">{picked.label}</option>}
            </select>
            {kind === "department" && (
              <select aria-label={C.PLAYBOOK_SCOPE_DEPT} className={`${FIELD} min-w-0 flex-1`} value={dept} onChange={(e) => setDept(e.target.value)} data-testid="ai-playbook-dept">
                {departments.map((d) => (
                  <option key={d}>{d}</option>
                ))}
              </select>
            )}
            {kind === "owner" && (
              <select aria-label={C.PLAYBOOK_SCOPE_OWNER} className={`${FIELD} min-w-0 flex-1`} value={owner} onChange={(e) => setOwner(e.target.value)} data-testid="ai-playbook-owner">
                {owners.map((d) => (
                  <option key={d}>{d}</option>
                ))}
              </select>
            )}
          </div>
        </div>
        <fieldset className="flex flex-col gap-1">
          <legend className="text-muted type-caption">{C.PLAYBOOK_LENGTH}</legend>
          <div className="flex gap-1" role="radiogroup">
            {AiPlaybookModel.LENGTHS.map((n) => (
              <button key={n} type="button" role="radio" aria-checked={length === n} className={`${GHOST} h-8 ${length === n ? "border-accent bg-accent/15" : ""}`} onClick={() => setLength(n)} data-testid={`ai-playbook-length-${n}`}>
                {n} min
              </button>
            ))}
          </div>
        </fieldset>
      </div>
      <label className="flex flex-col gap-1">
        <span className="text-muted type-caption">{C.PLAYBOOK_FOCUS}</span>
        <input className={FIELD} value={focus} maxLength={AiPlaybookModel.FOCUS_MAX} placeholder={C.PLAYBOOK_FOCUS_PLACEHOLDER} onChange={(e) => setFocus(e.target.value)} data-testid="ai-playbook-focus" />
      </label>
      <div className="flex items-center gap-3">
        <button type="button" className={TOOL_PRIMARY} disabled={!disabledNote && busy} {...pausedProps(disabledNote, "ai-playbook-off")} onClick={() => !disabledNote && make()} data-testid="ai-playbook-make">
          {busy ? C.PLAYBOOK_MAKING : C.PLAYBOOK_MAKE}
        </button>
        <span className="text-muted type-caption">{C.PLAYBOOK_INTRO}</span>
      </div>
      <AiOffNote id="ai-playbook-off" note={disabledNote} testId="ai-playbook-off-note" />
      {error && <AiAlert tone="danger" testId="ai-playbook-error">{error}</AiAlert>}
    </section>
  );
}

/** Saved playbooks (newest first), each reopenable. */
export function AiPlaybookSaved({ saved, currentId }: { saved: readonly AiPlaybookRecord[]; currentId: string | null }) {
  return (
    <nav aria-label={C.PLAYBOOK_SAVED} className={`${CARD} print:hidden`} data-testid="ai-playbook-saved">
      <h2 className="type-heading">{C.PLAYBOOK_SAVED}</h2>
      {saved.length === 0 ? (
        <p className="text-muted type-table">{C.PLAYBOOK_NONE_SAVED}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {saved.map((r) => (
            <li key={r.id}>
              <Link href={`/playbook?id=${r.id}`} aria-current={r.id === currentId ? "page" : undefined} className={`block rounded-control px-2 py-1 type-table hover:bg-white/[.04] ${r.id === currentId ? "bg-accent/15 text-fg" : "text-fg"}`}>
                <span className="type-table-strong">{AiPlaybookModel.meetingLabel(r.meetingType)}</span>
                <span className="block text-muted type-caption">
                  {r.scopeLabel}, {r.lengthMinutes} min, {new Date(r.createdAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </nav>
  );
}
