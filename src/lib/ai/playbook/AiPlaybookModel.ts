import type { ContextProject, PortfolioContextInput } from "../context/PortfolioContext";
import { PortfolioSignals } from "../context/PortfolioSignals";
import { ProjectStatusInfo } from "@/lib/domain/ProjectStatusInfo";

export type AiMeetingType = "biweekly_review" | "huddle" | "governance" | "contracts" | "one_on_one";
export type AiPlaybookLength = 15 | 30 | 60;
/** What the playbook covers: the whole line, one department, one owner, or chosen projects (rows or the current filter). */
export type AiPlaybookScope = { kind: "line" } | { kind: "department"; value: string } | { kind: "owner"; value: string } | { kind: "projects"; ids: string[]; label: string };

/** A project a playbook line points at (id and name as they were when the playbook was made). */
export type AiPlaybookRef = { id: string; name: string };

export interface AiPlaybook {
  bottomLine: string;
  decisions: { project: AiPlaybookRef; decision: string; who: string; ask: string; ifSlips: string }[];
  agenda: { title: string; minutes: number; projects: AiPlaybookRef[] }[];
  talkingPoints: { project: AiPlaybookRef; state: string; changed: string; blocker: string; owner: string; question: string; askWho: string; nextStep: string; nextDate: string | null }[];
  /** Computed in code from the signals (never from the model). */
  watchlist: { project: AiPlaybookRef; items: string[] }[];
  /** Computed in code from the blocker data, plus the model's pattern notes. */
  dependencies: { blockers: { project: AiPlaybookRef; status: string; blocking: AiPlaybookRef[] }[]; parties: { party: string; projects: AiPlaybookRef[]; items: string[] }[]; patterns: { text: string; projects: AiPlaybookRef[] }[] };
  wins: { project: AiPlaybookRef; text: string }[];
  followUps: { action: string; owner: string; due: string | null; project: AiPlaybookRef | null }[];
}

/** One saved playbook as the page lists and reopens it. */
export interface AiPlaybookRecord {
  id: string;
  meetingType: AiMeetingType;
  scopeLabel: string;
  scope: AiPlaybookScope;
  lengthMinutes: AiPlaybookLength;
  focus: string | null;
  content: AiPlaybook;
  createdAt: string;
}

const MAX_TEXT = 600;
const clip = (v: unknown, n = MAX_TEXT): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : "");
const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : []) as Record<string, unknown>[];

/** Words that make a name a role or group, not a person ("Contracts team", "Senior director"). */
const ROLE_WORDS = /\b(team|committee|governance|director|directors|manager|managers|lead|leads|leadership|vendor|vendors|contracts|it|security|council|board|office|department|dept|group|staff|owner|owners|sivat|viper|hpg|infor|pharmacy|finance|legal|you|me|nursing|physicians?|surgeons?|admin|administration|executive|vp|cfo|cno|cmo|coo|ceo)\b/i;

/**
 * Meeting Playbook item: the playbook's pure rules. The model writes the judgment parts (bottom line, decisions, agenda,
 * talking points, patterns, wins); the watchlist, the blocker groups and the follow-up prefill are computed here from
 * the shared context, so they always match the dashboard. Every line must point at a project in scope, every person
 * must be someone the tracker names (otherwise "No owner assigned"), and dates must be real.
 */
export class AiPlaybookModel {
  static readonly MEETING_TYPES: readonly { id: AiMeetingType; label: string; guide: string }[] = [
    { id: "biweekly_review", label: "Biweekly portfolio review with my senior director", guide: "Lead with portfolio health and the biggest risks. Cover Off track and At risk projects, overdue items, escalations the director must make or unblock, and wins worth recognizing." },
    { id: "huddle", label: "Department or manager huddle", guide: "Focus on this group's projects: what is due in the next two weeks, who owns each next step, and what is stuck. Keep it practical." },
    { id: "governance", label: "Governance meeting (Invasive or EP Governance, SIVAT prep)", guide: "Focus on items needing committee review, approval or a date: what is queued, what is ready, what is missing before it can go, and who presents it." },
    { id: "contracts", label: "Contracts or vendor sync", guide: "Focus on contracts, quotes, redlines and vendor dependencies: what each vendor or contracts lead owes, how long it has waited, and the follow-up dates." },
    { id: "one_on_one", label: "1:1 with a manager", guide: "Focus on this person's projects: their next steps, their blockers, where they need help, and recognition." },
  ];
  static readonly LENGTHS: readonly AiPlaybookLength[] = [15, 30, 60];
  static readonly MAX_TOKENS = 6000;
  static readonly FOCUS_MAX = 500;

  static meetingType(raw: unknown): AiMeetingType | null {
    return AiPlaybookModel.MEETING_TYPES.find((m) => m.id === raw)?.id ?? null;
  }
  static meetingLabel(t: AiMeetingType): string {
    return AiPlaybookModel.MEETING_TYPES.find((m) => m.id === t)!.label;
  }
  static lengthOf(raw: unknown): AiPlaybookLength | null {
    const n = Number(raw);
    return (AiPlaybookModel.LENGTHS as readonly number[]).includes(n) ? (n as AiPlaybookLength) : null;
  }

  /** The browser's scope, checked. Null = unreadable. */
  static scope(raw: unknown): AiPlaybookScope | null {
    const r = raw as { kind?: unknown; value?: unknown; ids?: unknown; label?: unknown } | null;
    if (!r || typeof r !== "object") return null;
    if (r.kind === "line") return { kind: "line" };
    if ((r.kind === "department" || r.kind === "owner") && typeof r.value === "string" && r.value.trim()) return { kind: r.kind, value: r.value.trim().slice(0, 120) };
    if (r.kind === "projects" && Array.isArray(r.ids)) {
      const ids = [...new Set(r.ids.filter((x): x is string => typeof x === "string" && /^[0-9a-f-]{36}$/i.test(x)))].slice(0, 500);
      return ids.length ? { kind: "projects", ids, label: clip(r.label, 120) || `${ids.length} selected projects` } : null;
    }
    return null;
  }

  static scopeLabel(s: AiPlaybookScope, lineName: string): string {
    if (s.kind === "line") return `All of ${lineName}`;
    if (s.kind === "department") return `Department: ${s.value}`;
    if (s.kind === "owner") return `Owner: ${s.value}`;
    return s.label;
  }

  /** The scoped projects (ids), from the viewer's line. Department and owner match case-insensitively. */
  static inScope<T extends { id: string; department?: string | null; owner?: string | null }>(projects: readonly T[], s: AiPlaybookScope): T[] {
    const eq = (a: string | null | undefined, b: string) => (a ?? "").trim().toLowerCase() === b.trim().toLowerCase();
    if (s.kind === "line") return [...projects];
    if (s.kind === "department") return projects.filter((p) => eq(p.department, s.value));
    if (s.kind === "owner") return projects.filter((p) => eq(p.owner, s.value));
    const ids = new Set(s.ids);
    return projects.filter((p) => ids.has(p.id));
  }

  static system(type: AiMeetingType, length: AiPlaybookLength, context: string): string {
    const m = AiPlaybookModel.MEETING_TYPES.find((x) => x.id === type)!;
    return [
      `You prepare a meeting playbook for a hospital project portfolio lead. Meeting: ${m.label}, ${length} minutes. ${m.guide}`,
      "Use only the portfolio context below. Every project you mention must be one of its refs (P1, P2, ...). Never invent people, dates, numbers or projects. A person must be someone named in the context (owner, requester, contracts lead, milestone owner, follow-up owner); if nobody is named, write No owner assigned. Groups and roles (the contracts team, SIVAT, your senior director) are fine.",
      "'What changed' must come from changedFields, priorUpdates and the history facts, not a restatement of the Latest update. The real blocker comes from blockedBy and externalBlockers when present. Use the flags; they are computed by the app and are true.",
      "Reply with one JSON object and nothing else:",
      '{"bottomLine": "3 to 4 sentences: portfolio health, the single biggest risk, and what is needed from this meeting",',
      ' "decisions": [{"ref": "P1", "decision": "...", "who": "who must decide", "ask": "my recommended ask", "ifSlips": "what happens if it slips"}],',
      ` "agenda": [{"title": "...", "minutes": 5, "refs": ["P1"]}]  (ordered by priority, minutes adding up to at most ${length}),`,
      ' "talkingPoints": [{"ref": "P1", "state": "one line", "changed": "since the last report", "blocker": "the real blocker or None", "owner": "...", "question": "the specific question", "askWho": "who to ask", "nextStep": "recommended next step", "nextDate": "YYYY-MM-DD"}]  (only projects that matter for this meeting),',
      ' "patterns": [{"text": "a dependency or pattern across projects, e.g. one supply contract holding up two projects, or several items waiting on the same person or committee", "refs": ["P1", "P2"]}],',
      ' "wins": [{"ref": "P1", "text": "..."}],',
      ' "followUps": [{"action": "...", "owner": "...", "due": "YYYY-MM-DD", "ref": "P1"}]}',
      "Portfolio context:",
      context,
    ].join("\n");
  }

  static user(focus: string | null): string {
    return focus ? `Focus for this meeting: ${focus}` : "No extra focus. Use the meeting type.";
  }

  /** Everyone the scoped context names (lowercase), the only people a playbook may name. */
  static people(projects: readonly ContextProject[]): Set<string> {
    const out = new Set<string>();
    const add = (v: string | null | undefined) => v?.trim() && out.add(v.trim().toLowerCase());
    for (const p of projects) {
      add(p.owner);
      add(p.requester);
      add(p.contractsLead);
      add(p.milestoneOwner);
      for (const m of p.milestones) add(m.owner);
      for (const b of p.external) add(b.followUpOwner);
    }
    return out;
  }

  /** A person the tracker names, a role or group, or "No owner assigned" (never a made-up name). */
  static person(v: unknown, people: ReadonlySet<string>, fallback = AiPlaybookModel.NO_OWNER): string {
    const t = clip(v, 120);
    if (!t || /^(none|n\/a|unknown|to assign|unassigned|tbd)$/i.test(t)) return fallback;
    if (people.has(t.toLowerCase())) return t;
    // Names joined with "and" or commas: every part must pass.
    const parts = t.split(/\s*(?:,|\band\b|&|\/)\s*/i).filter(Boolean);
    if (parts.length > 1) return parts.every((x) => AiPlaybookModel.person(x, people, "") !== "") ? t : fallback;
    if (ROLE_WORDS.test(t)) return t;
    // A bare first name of exactly one person the tracker names.
    const first = [...people].filter((p) => p.split(" ")[0] === t.toLowerCase());
    if (first.length === 1 && !t.includes(" ")) return t;
    return fallback;
  }

  /** A real YYYY-MM-DD date, or null. `notBefore` drops recommendations in the past. */
  static date(v: unknown, notBefore?: string): string | null {
    const t = clip(v, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return null;
    const d = new Date(`${t}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== t) return null;
    return notBefore && t < notBefore ? null : t;
  }

  /** The code-computed watchlist (the same signals as the dashboard and report). */
  static watchlist(projects: readonly ContextProject[]): AiPlaybook["watchlist"] {
    return projects
      .map((p) => {
        const items = PortfolioSignals.words(p.signals).map((w) => (w === "overdue" && p.dueDate ? `overdue (due ${p.dueDate}${p.nextMilestone ? `, ${p.nextMilestone}` : ""})` : w === "due within 14 days" && p.dueDate ? `due ${p.dueDate}${p.nextMilestone ? ` (${p.nextMilestone})` : ""}` : w));
        return { project: { id: p.id, name: p.name }, items: [...items, ...p.blockerFlags] };
      })
      .filter((w) => w.items.length);
  }

  /** Blocker projects with what they hold up, and outside blockers grouped by who they wait on (to clear several at once). */
  static dependencies(projects: readonly ContextProject[]): Omit<AiPlaybook["dependencies"], "patterns"> {
    const byId = new Map(projects.map((p) => [p.id, p]));
    const blockers = new Map<string, { project: AiPlaybookRef; status: string; blocking: AiPlaybookRef[] }>();
    for (const p of projects)
      for (const b of p.blockedBy) {
        const e = blockers.get(b.id) ?? { project: { id: b.id, name: b.name }, status: ProjectStatusInfo.label(byId.get(b.id)?.status ?? b.status), blocking: [] };
        e.blocking.push({ id: p.id, name: p.name });
        blockers.set(b.id, e);
      }
    const parties = new Map<string, { party: string; projects: AiPlaybookRef[]; items: string[] }>();
    for (const p of projects)
      for (const x of p.external) {
        const key = x.waitingOn.trim().toLowerCase();
        const e = parties.get(key) ?? { party: x.waitingOn.trim(), projects: [], items: [] };
        if (!e.projects.some((r) => r.id === p.id)) e.projects.push({ id: p.id, name: p.name });
        e.items.push(`${p.name}: ${x.description}${x.days !== null ? ` (${x.days} days)` : ""}${x.followUpOn ? `, follow up ${x.followUpOn}` : ""}${x.followUpOwner ? ` by ${x.followUpOwner}` : ""}`);
        parties.set(key, e);
      }
    return {
      blockers: [...blockers.values()].sort((a, b) => b.blocking.length - a.blocking.length || a.project.name.localeCompare(b.project.name)),
      parties: [...parties.values()].sort((a, b) => b.projects.length - a.projects.length || a.party.localeCompare(b.party)),
    };
  }

  /** Agenda minutes scaled down to fit the meeting length (rounded, at least 1 each), empty items dropped. */
  static fit(agenda: AiPlaybook["agenda"], length: number): AiPlaybook["agenda"] {
    const items = agenda.filter((a) => a.title).slice(0, 12);
    const total = items.reduce((s, a) => s + a.minutes, 0);
    if (total <= length) return items;
    const scaled = items.map((a) => ({ ...a, minutes: Math.max(1, Math.floor((a.minutes * length) / total)) }));
    while (scaled.reduce((s, a) => s + a.minutes, 0) > length && scaled.some((a) => a.minutes > 1)) {
      const big = scaled.reduce((m, a, i) => (a.minutes > scaled[m].minutes ? i : m), 0);
      scaled[big].minutes -= 1;
    }
    return scaled;
  }

  /**
   * The model's reply, checked against the scoped context. Lines with an unknown ref are dropped, people are checked,
   * dates must be real (recommended dates not in the past). The watchlist and blocker groups are computed, and the
   * follow-up tracker is pre-filled from the asks and next steps. Null = unreadable.
   */
  static parse(text: string, input: Pick<PortfolioContextInput, "projects" | "today">, length: AiPlaybookLength): AiPlaybook | null {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    let b: Record<string, unknown>;
    try {
      b = JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
    const projects = input.projects;
    const ref = (r: unknown): AiPlaybookRef | null => {
      const m = typeof r === "string" ? /^P(\d+)$/i.exec(r.trim()) : null;
      const p = m ? projects[Number(m[1]) - 1] : undefined;
      return p ? { id: p.id, name: p.name } : null;
    };
    const refs = (v: unknown) => {
      const out: AiPlaybookRef[] = [];
      for (const r of Array.isArray(v) ? v : []) {
        const x = ref(r);
        if (x && !out.some((o) => o.id === x.id)) out.push(x);
      }
      return out;
    };
    const people = AiPlaybookModel.people(projects);
    const who = (v: unknown) => AiPlaybookModel.person(v, people);
    const bottomLine = clip(b.bottomLine, 1200);
    if (!bottomLine) return null;

    const decisions = arr(b.decisions).flatMap((d) => {
      const project = ref(d.ref);
      const decision = clip(d.decision);
      return project && decision ? [{ project, decision, who: who(d.who), ask: clip(d.ask), ifSlips: clip(d.ifSlips) }] : [];
    });
    const agenda = AiPlaybookModel.fit(
      arr(b.agenda).map((a) => ({ title: clip(a.title, 160), minutes: Math.max(1, Math.min(length, Math.round(Number(a.minutes)) || 1)), projects: refs(a.refs) })),
      length,
    );
    const talkingPoints = arr(b.talkingPoints).flatMap((t) => {
      const project = ref(t.ref);
      if (!project) return [];
      const p = projects.find((x) => x.id === project.id)!;
      return [{ project, state: clip(t.state), changed: clip(t.changed) || AiPlaybookModel.NOTHING_CHANGED, blocker: clip(t.blocker) || "None", owner: p.owner?.trim() || AiPlaybookModel.NO_OWNER, question: clip(t.question), askWho: who(t.askWho), nextStep: clip(t.nextStep), nextDate: AiPlaybookModel.date(t.nextDate, input.today) }];
    });
    const patterns = arr(b.patterns).flatMap((x) => {
      const text = clip(x.text);
      return text ? [{ text, projects: refs(x.refs) }] : [];
    });
    const wins = arr(b.wins).flatMap((w) => {
      const project = ref(w.ref);
      const text = clip(w.text);
      return project && text ? [{ project, text }] : [];
    });
    const followUps: AiPlaybook["followUps"] = [];
    const addFollow = (f: AiPlaybook["followUps"][number]) => {
      if (f.action && !followUps.some((x) => x.action.toLowerCase() === f.action.toLowerCase())) followUps.push(f);
    };
    for (const d of decisions) if (d.ask) addFollow({ action: d.ask, owner: d.who, due: null, project: d.project });
    for (const t of talkingPoints) if (t.nextStep) addFollow({ action: t.nextStep, owner: t.askWho, due: t.nextDate, project: t.project });
    for (const f of arr(b.followUps)) addFollow({ action: clip(f.action), owner: who(f.owner), due: AiPlaybookModel.date(f.due, input.today), project: ref(f.ref) });

    return {
      bottomLine,
      decisions,
      agenda,
      talkingPoints,
      watchlist: AiPlaybookModel.watchlist(projects),
      dependencies: { ...AiPlaybookModel.dependencies(projects), patterns },
      wins,
      followUps: followUps.slice(0, 40),
    };
  }

  /** The playbook's follow-ups as context for Meeting notes to updates ("Process meeting notes"). */
  static notesPrefix(r: Pick<AiPlaybookRecord, "meetingType" | "createdAt" | "scopeLabel"> & { content: Pick<AiPlaybook, "followUps"> }): string {
    const lines = r.content.followUps.map((f) => `- ${f.action} (${f.owner}${f.due ? `, ${f.due}` : ""}${f.project ? `, ${f.project.name}` : ""})`);
    return [`Context: these notes are from the meeting "${AiPlaybookModel.meetingLabel(r.meetingType)}" on ${r.createdAt.slice(0, 10)} (${r.scopeLabel}). Turn agreed follow-ups into milestone or update changes.`, "Planned follow-ups:", ...lines, "Meeting notes:"].join("\n");
  }

  static readonly NO_OWNER = "No owner assigned";
  static readonly NOTHING_CHANGED = "No change recorded since the last report";

  /** Email-ready plain text (also what Copy puts on the clipboard). */
  static text(r: Pick<AiPlaybookRecord, "meetingType" | "scopeLabel" | "lengthMinutes" | "focus" | "createdAt"> & { content: AiPlaybook }): string {
    const p = r.content;
    const L: string[] = [];
    L.push(`Meeting Playbook: ${AiPlaybookModel.meetingLabel(r.meetingType)} (${r.lengthMinutes} min)`, `${r.scopeLabel}. Prepared ${r.createdAt.slice(0, 10)}.${r.focus ? ` Focus: ${r.focus}` : ""}`, "");
    L.push("1. Bottom line", p.bottomLine, "");
    L.push("2. Decisions and escalations needed");
    if (!p.decisions.length) L.push("None.");
    for (const d of p.decisions) L.push(`- ${d.project.name}: ${d.decision} Who decides: ${d.who}. Ask: ${d.ask || "None"}. If it slips: ${d.ifSlips || "Not stated"}.`);
    L.push("", "3. Agenda");
    p.agenda.forEach((a, i) => L.push(`${i + 1}. ${a.title} (${a.minutes} min)${a.projects.length ? `: ${a.projects.map((x) => x.name).join(", ")}` : ""}`));
    L.push("", "4. Project talking points");
    for (const t of p.talkingPoints) {
      L.push(`- ${t.project.name}`, `  Now: ${t.state}`, `  Changed: ${t.changed}`, `  Blocker: ${t.blocker}`, `  Owner: ${t.owner}`, `  Ask ${t.askWho}: ${t.question}`, `  Next step: ${t.nextStep}${t.nextDate ? ` by ${t.nextDate}` : ""}`);
    }
    L.push("", "5. Watchlist");
    if (!p.watchlist.length) L.push("Nothing flagged.");
    for (const w of p.watchlist) L.push(`- ${w.project.name}: ${w.items.join("; ")}`);
    L.push("", "6. Dependencies and patterns");
    for (const b of p.dependencies.blockers) L.push(`- ${b.project.name} (${b.status}) is holding up ${b.blocking.map((x) => x.name).join(", ")}`);
    for (const g of p.dependencies.parties) L.push(`- Waiting on ${g.party}: ${g.items.join("; ")}`);
    for (const x of p.dependencies.patterns) L.push(`- ${x.text}`);
    if (!p.dependencies.blockers.length && !p.dependencies.parties.length && !p.dependencies.patterns.length) L.push("None recorded.");
    L.push("", "7. Wins to recognize");
    if (!p.wins.length) L.push("None this time.");
    for (const w of p.wins) L.push(`- ${w.project.name}: ${w.text}`);
    L.push("", "8. Follow-up tracker");
    for (const f of p.followUps) L.push(`- ${f.action} | ${f.owner} | ${f.due ?? "No date"}${f.project ? ` | ${f.project.name}` : ""}`);
    return L.join("\n");
  }

  /** A Word-readable HTML document (downloaded as .doc). Escaped. */
  static wordHtml(r: Parameters<typeof AiPlaybookModel.text>[0]): string {
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const body = AiPlaybookModel.text(r)
      .split("\n")
      .map((l) => (/^\d\. [A-Z]/.test(l) && !l.includes("(") ? `<h2>${esc(l)}</h2>` : l.startsWith("Meeting Playbook:") ? `<h1>${esc(l)}</h1>` : l ? `<p>${esc(l)}</p>` : ""))
      .join("\n");
    return `<html><head><meta charset="utf-8"><title>Meeting Playbook</title></head><body style="font-family: Calibri, Arial, sans-serif; font-size: 11pt">${body}</body></html>`;
  }
}
