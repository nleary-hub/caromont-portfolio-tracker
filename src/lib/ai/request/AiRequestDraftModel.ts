import { AiToolsModel, type AiProjectDraft, type AiToolProject } from "@/lib/ai/AiToolsModel";
import { AiToolsPrompts } from "@/lib/ai/AiToolsPrompts";
import { AiActionModel } from "@/lib/ai/actions/AiActionModel";
import type { DepartmentInfo } from "@/lib/domain/ServiceAreaInfo";
import type { MilestoneDraft } from "@/lib/domain/MilestoneRules";

/** One of the line's milestone templates (Admin > Templates), as the request draft sees it. */
export interface AiRequestTemplate {
  id: string;
  name: string;
  steps: string[];
}

/** Item 7: the draft project plus what the request names: department, requester, REQ number and the matched template. */
export interface AiRequestDraft extends AiProjectDraft {
  /** A department id of the line, or "" when the request does not say. */
  department: string;
  /** A name from the Requesters list (the physician champion column), or "" when the request does not name one. */
  requester: string;
  /** Infor REQ number (digits), or "". */
  inforRequestNumber: string;
  /** The matched template's id, or "" for none. */
  templateId: string;
}

/** An existing project the request may duplicate. */
export interface AiRequestDuplicate {
  projectId: string;
  name: string;
  why: string;
}

export interface AiRequestLists {
  departments: readonly DepartmentInfo[];
  requesters: readonly string[];
  templates: readonly AiRequestTemplate[];
}

/** Existing project facts the code-side duplicate check reads. */
export interface AiRequestExisting extends AiToolProject {
  inforRequestNumber: number | null;
}

/** Words too common in project names to signal a duplicate on their own. */
const GENERIC = new Set(
  "the and for with from into new request project projects program plan phase update review renewal contract contracts agreement agreements rebate rebates supply supplies consignment pricing price upgrade refresh build buildout out lab labs room rooms system systems equipment implementation install installation replacement purchase service services line add adding expand expansion support vendor second third first".split(
    " ",
  ),
);

/**
 * Item 7: Request to draft project on the shared context. The model sees the line's projects (to spot duplicates), the
 * templates (to pick one), and the Departments and Requesters lists (to pre-fill only names that are on them). The code
 * then checks every value against those lists and runs its own duplicate check (same REQ number, or a shared
 * distinctive name word such as a vendor). Saves nothing.
 */
export class AiRequestDraftModel {
  static readonly MAX_TOKENS = 4000;
  static readonly WHY_MAX = 200;
  static readonly DUPLICATES_MAX = 3;

  static system(context: string, lists: AiRequestLists): string {
    const depts = lists.departments.filter((d) => !d.archived && !d.deleted).map((d) => `${d.name} (${d.shortName})`);
    const templates = lists.templates.map((t, i) => `T${i + 1} ${t.name}: ${t.steps.join("; ")}`);
    return [
      "You turn a pasted project request into a draft project record for a hospital service line portfolio tracker.",
      'Reply with JSON only, in this shape: {"project":{"name":"","description":"","nextMilestone":"","dueDate":"","targetCompletion":"","note":"","department":"","requester":"","inforRequestNumber":"","template":""},"duplicate":{"ref":"","why":""}}',
      "- name: a short project name, 80 characters or fewer.",
      "- description: what the project is, 200 characters or fewer.",
      "- nextMilestone: the first action, 10 words or fewer. dueDate and targetCompletion only when the request states them, else empty.",
      "- note: a one or two sentence summary of the request.",
      "- department: one of the Departments below, only when the request names it or clearly says where the work is. Else empty.",
      "- requester: the requester or physician champion, only when the request names someone on the Requesters list below. Else empty. Never invent a name.",
      "- inforRequestNumber: the REQ number when the request gives one (digits only), else empty.",
      '- template: the ref (e.g. "T2") of the template below that fits this kind of project, or empty when none fits.',
      "- duplicate: when a project in the list below is already this same request (same REQ number, or the same vendor and the same kind of work), its ref and a short reason. Else leave ref empty.",
      "- Never fill in an owner.",
      ...AiToolsPrompts.COMMON,
      "",
      `Departments: ${depts.join(", ") || "none"}`,
      `Requesters: ${lists.requesters.join(", ") || "none"}`,
      "Templates:",
      ...(templates.length ? templates : ["none"]),
      "",
      context,
    ].join("\n");
  }

  static department(departments: readonly DepartmentInfo[], raw: unknown): string {
    const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
    if (!v) return "";
    const d = departments.find((x) => !x.archived && !x.deleted && [x.id, x.name, x.shortName].some((k) => String(k).toLowerCase() === v || `${x.name} (${x.shortName})`.toLowerCase() === v));
    return d ? d.id : "";
  }

  static requester(requesters: readonly string[], raw: unknown): string {
    return typeof raw === "string" && raw.trim() ? (AiActionModel.person(requesters, raw) ?? "") : "";
  }

  static req(raw: unknown): string {
    const v = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.replace(/^\s*REQ[-\s#]*/i, "").trim() : "";
    return /^\d{1,5}$/.test(v) && Number(v) >= 1 ? String(Number(v)) : "";
  }

  /** Checks a draft (the AI's or the edited one) against the lists. null when the base fields are invalid. */
  static clean(raw: unknown, lists: AiRequestLists): AiRequestDraft | null {
    const base = AiToolsModel.cleanDraft(raw);
    if (!base) return null;
    const o = raw as Record<string, unknown>;
    const template = typeof o.templateId === "string" ? o.templateId : "";
    return {
      ...base,
      department: AiRequestDraftModel.department(lists.departments, o.department),
      requester: AiRequestDraftModel.requester(lists.requesters, o.requester),
      inforRequestNumber: AiRequestDraftModel.req(o.inforRequestNumber),
      templateId: lists.templates.some((t) => t.id === template) ? template : "",
    };
  }

  /** Reads the reply. The AI's template ref ("T2") becomes the template id, its duplicate ref the project. null = unreadable. */
  static parse(text: string, lists: AiRequestLists, projects: readonly AiToolProject[]): { draft: AiRequestDraft; duplicate: AiRequestDuplicate | null } | null {
    const body = AiToolsModel.json(text) as { project?: Record<string, unknown>; duplicate?: Record<string, unknown> } | null;
    if (!body || !body.project || typeof body.project !== "object") return null;
    const t = typeof body.project.template === "string" ? /^T(\d+)$/i.exec(body.project.template.trim()) : null;
    const templateId = t ? (lists.templates[Number(t[1]) - 1]?.id ?? "") : "";
    const draft = AiRequestDraftModel.clean({ ...body.project, templateId }, lists);
    if (!draft) return null;
    const d = body.duplicate;
    const m = d && typeof d.ref === "string" ? /^P(\d+)$/i.exec(d.ref.trim()) : null;
    const p = m ? projects[Number(m[1]) - 1] : undefined;
    const why = d && typeof d.why === "string" ? d.why.trim().replace(/\u2014/g, ",").slice(0, AiRequestDraftModel.WHY_MAX) : "";
    return { draft, duplicate: p ? { projectId: p.id, name: p.name, why } : null };
  }

  static words(name: string): string[] {
    return [...new Set(name.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length >= 4 && !GENERIC.has(w) && !/^\d+$/.test(w)))];
  }

  /**
   * The code-side duplicate check: the same REQ number, or a shared distinctive name word (a vendor or device, e.g.
   * "Zilver" or "Penumbra"). The AI's pick comes first; at most DUPLICATES_MAX, most shared words first.
   */
  static duplicates(draft: AiRequestDraft, existing: readonly AiRequestExisting[], ai: AiRequestDuplicate | null): AiRequestDuplicate[] {
    const out: AiRequestDuplicate[] = ai ? [ai] : [];
    const seen = new Set(out.map((d) => d.projectId));
    const req = draft.inforRequestNumber ? Number(draft.inforRequestNumber) : null;
    for (const p of existing) {
      if (!req || p.inforRequestNumber !== req || seen.has(p.id)) continue;
      out.push({ projectId: p.id, name: p.name, why: `Same REQ number (${req}).` });
      seen.add(p.id);
    }
    const mine = AiRequestDraftModel.words(`${draft.name} ${draft.description}`);
    const scored = existing
      .filter((p) => !seen.has(p.id))
      .map((p) => ({ p, shared: AiRequestDraftModel.words(p.name).filter((w) => mine.includes(w)) }))
      .filter((x) => x.shared.length > 0)
      .sort((a, b) => b.shared.length - a.shared.length || a.p.name.localeCompare(b.p.name));
    for (const x of scored) out.push({ projectId: x.p.id, name: x.p.name, why: `Name shares "${x.shared.map((w) => w[0].toUpperCase() + w.slice(1)).join('", "')}".` });
    return out.slice(0, AiRequestDraftModel.DUPLICATES_MAX);
  }

  /** The template's steps as the new project's checklist: in order, not done, the draft's due date on the first. */
  static steps(template: AiRequestTemplate | undefined, dueDate: string): MilestoneDraft[] {
    return (template?.steps ?? []).map((name, i) => ({ id: null, name, dueDate: i === 0 ? dueDate : "", done: false, sourceTemplateId: template!.id, owner: null }));
  }

  /** The new project as the normal create receives it: Not started, no owner; department, requester and REQ only when named. */
  static input(d: AiRequestDraft): Record<string, string | null> {
    return {
      ...AiToolsModel.draftInput(d),
      serviceArea: d.department || null,
      physicianChampion: d.requester || null,
      inforRequestNumber: d.inforRequestNumber || null,
    };
  }
}
