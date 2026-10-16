import { TemplatesEditor } from "../../src/components/TemplatesEditor";
import { AiTemplateModel, type AiTemplateDesired, type AiTemplateProposal } from "../../src/lib/ai/AiTemplateModel";
import { AiToolsCopy } from "../../src/lib/ai/AiToolsCopy";
import type { TemplateDto } from "../../src/lib/services/MilestoneTemplateService";

// Fictional templates and in-memory actions only (?templates=1). No auth, database or network.
let templates: TemplateDto[] = [
  { id: "tpl-clinic", name: "Clinic opening", position: 1, items: ["Site lease signed", "Equipment ordered", "Staff hired", "Signage installed", "Go-live"].map((name, i) => ({ id: `it-${i + 1}`, name, position: i + 1 })) },
  { id: "tpl-vendor", name: "Vendor agreement", position: 2, items: ["Scope agreed", "Contract signed"].map((name, i) => ({ id: `iv-${i + 1}`, name, position: i + 1 })) },
];
const EDIT: AiTemplateProposal = {
  name: "New clinic opening",
  steps: [
    { from: "S3", name: "Staff hired and trained" },
    { from: "S1", name: "Site lease signed" },
    { from: "S2", name: "Equipment ordered" },
    { from: null, name: "Soft launch with a small patient group first" },
    { from: null, name: "Soft launch" },
    { from: "S5", name: "Go-live" },
  ],
};
const DRAFT: AiTemplateProposal = { name: "Clinic opening", steps: ["Site selected", "Lease signed", "Build-out complete", "Equipment installed", "Staff hired", "Go-live"].map((name) => ({ from: null, name })) };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let n = 0;

(globalThis as unknown as { __fixtureActions: Record<string, (...a: never[]) => unknown> }).__fixtureActions = {
  proposeAiTemplate: (async (mode: string, input: string, id: string | null) => {
    await wait(Number(new URLSearchParams(window.location.search).get("delay") ?? 400));
    if (/fail/i.test(input)) return { ok: false, kind: "provider", message: AiToolsCopy.PROVIDER_ERROR };
    const current = mode === "edit" ? (templates.find((t) => t.id === id) ?? null) : null;
    return { ok: true, proposalId: `00000000-0000-4000-8000-00000000000${++n}`, mode, templateId: current?.id ?? null, rows: AiTemplateModel.diff(current, mode === "edit" ? EDIT : DRAFT) };
  }) as never,
  applyAiTemplate: (async (_p: string, id: string | null, d: AiTemplateDesired) => {
    await wait(150);
    const tid = id ?? `tpl-new-${++n}`;
    const t: TemplateDto = { id: tid, name: d.name, position: id ? templates.find((x) => x.id === id)!.position : templates.length + 1, items: d.steps.map((s, i) => ({ id: s.id ?? `new-${tid}-${i}`, name: s.name, position: i + 1 })) };
    templates = id ? templates.map((x) => (x.id === id ? t : x)) : [...templates, t];
    return { ok: true, templateId: tid, templates };
  }) as never,
  discardAiTemplate: (async () => ({ ok: true })) as never,
};

export function TemplatesFixture() {
  const q = new URLSearchParams(window.location.search);
  return (
    <main className="mx-auto flex max-w-[1100px] flex-col gap-6 px-6 py-6">
      <h1 className="type-title">Milestone templates</h1>
      <TemplatesEditor initial={templates} aiNote={q.get("model") === "off" ? AiToolsCopy.MODEL_OFF_NOTE : null} readOnly={q.get("readonly") === "1"} />
    </main>
  );
}
