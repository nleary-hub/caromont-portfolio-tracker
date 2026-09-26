"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { InforNumber } from "@/lib/domain/InforNumber";
import { ProjectStatusInfo } from "@/lib/domain/ProjectStatusInfo";
import { ServiceAreaInfo } from "@/lib/domain/ServiceAreaInfo";
import type { MilestoneEdit } from "@/lib/domain/MilestoneRules";
import { MilestoneEditorModel } from "@/lib/projects/MilestoneEditorModel";
import { ProjectFormModel, type FormField, type ProjectFormValues } from "@/lib/projects/ProjectFormModel";
import type { MilestoneStepDto } from "@/lib/services/MilestoneService";
import type { TemplateDto } from "@/lib/services/MilestoneTemplateService";
import type { FieldErrors } from "@/lib/validation/ProjectValidator";
import { MilestonesEditor } from "./MilestonesEditor";

/**
 * Resolves to the saved project's id, or a message plus per-field errors from ProjectValidator. `milestones`
 * is the checklist when it changed in this edit (null otherwise); it saves with the other fields.
 */
export type ProjectFormSubmit = (
  values: Partial<ProjectFormValues>,
  milestones: MilestoneEdit | null,
) => Promise<{ ok: true; id: string } | { ok: false; error: string; fieldErrors?: FieldErrors }>;

export interface ProjectEditFormProps {
  mode: "edit" | "new";
  /** Stored values (ProjectFormModel.empty() for a new project). */
  original: ProjectFormValues;
  /** Stored checklist steps ([] for a new project or one without steps). */
  milestones: readonly MilestoneStepDto[];
  /** Templates for "Apply a template". */
  templates: readonly TemplateDto[];
  /** YYYY-MM-DD in America/New_York (Completed on prefill). */
  today: string;
  /** The People editor (saves on pick). Null for a new project. */
  people: ReactNode;
  /** Delete project with its confirmation. Null for a new project. */
  adminDelete: ReactNode;
  /** Edit: the changed fields. New: every field. */
  onSubmit: ProjectFormSubmit;
  onSaved: (id: string) => void;
  /** Cancel pressed; the drawer asks "Discard changes?" when dirty. */
  onCancel: () => void;
  onDirtyChange: (dirty: boolean) => void;
  /** Drawer asks to discard (close, Esc, Cancel or another row with unsaved changes). */
  confirmDiscard: boolean;
  onKeepEditing: () => void;
  onDiscard: () => void;
}

const INPUT = "h-8 w-full min-w-0 rounded-control border border-line bg-input px-2.5 text-fg type-table focus:border-accent focus:outline-none";
const TEXTAREA = "block w-full min-w-0 resize-none rounded-control border border-line bg-input px-2.5 py-2 text-fg type-table focus:border-accent focus:outline-none";

/**
 * Admin drawer edit form (and New project). Every non-People field saves together on Save, as one
 * history entry; People keep saving on pick. Instant checks come from ProjectFormModel, and the
 * server repeats them through ProjectValidator and returns field errors.
 */
export function ProjectEditForm({
  mode,
  original: originalProp,
  milestones,
  templates,
  today,
  people,
  adminDelete,
  onSubmit,
  onSaved,
  onCancel,
  onDirtyChange,
  confirmDiscard,
  onKeepEditing,
  onDiscard,
}: ProjectEditFormProps) {
  const isNew = mode === "new";
  // Snapshot at open: a People autosave refreshes the page data but must not reset the form.
  const [original] = useState<ProjectFormValues>(originalProp);
  const [values, setValues] = useState<ProjectFormValues>(originalProp);
  const [touched, setTouched] = useState<Partial<Record<FormField, boolean>>>({});
  const [attempted, setAttempted] = useState(false);
  const [serverErrors, setServerErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Checklist: local until Save, like the other fields (one history group per save).
  const [msOriginal] = useState(() => MilestoneEditorModel.initial(milestones, { nextMilestone: originalProp.nextMilestone, dueDate: originalProp.dueDate }));
  const [ms, setMs] = useState(msOriginal);
  const msDirty = MilestoneEditorModel.isDirty(ms, msOriginal);
  const msStepErrors = MilestoneEditorModel.errors(ms, msOriginal);

  const dirty = ProjectFormModel.isDirty(values, original) || msDirty;
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);

  // The next milestone the checklist yields (first step not done, else the last step) stands in for the old
  // Next milestone field in the "required for this status" check.
  const derivedNext = ms.steps.find((s) => !s.done)?.name ?? ms.steps.at(-1)?.name ?? "";
  const checkedValues = useMemo(() => ({ ...values, nextMilestone: derivedNext }), [values, derivedNext]);
  const checkedOriginal = useMemo(() => ({ ...original, nextMilestone: msOriginal.steps.find((s) => !s.done)?.name ?? msOriginal.steps.at(-1)?.name ?? "" }), [original, msOriginal]);
  const clientErrors = useMemo(() => {
    const e = ProjectFormModel.errors(checkedValues, checkedOriginal, isNew);
    if (Object.keys(msStepErrors).length) e.milestones = ["Fix the highlighted milestones"];
    return e;
  }, [checkedValues, checkedOriginal, isNew, msStepErrors]);
  const shown = (f: FormField): string[] => {
    const client = attempted || touched[f] || values[f] !== original[f] ? (clientErrors[f] ?? []) : [];
    return [...client, ...(serverErrors[f] ?? [])].filter((m, i, all) => all.indexOf(m) === i);
  };
  // Checklist messages: the milestone requirement (shown once attempted or edited), step errors, server errors.
  const milestoneMessages = [
    ...(attempted || msDirty || values.status !== original.status ? (clientErrors.nextMilestone ?? []) : []),
    ...(serverErrors.nextMilestone ?? []),
    ...(serverErrors.milestones ?? []),
  ].filter((m, i, all) => all.indexOf(m) === i);
  const allErrors: FieldErrors = {};
  for (const f of ProjectFormModel.ORDER) {
    const list = [...(clientErrors[f] ?? []), ...(serverErrors[f] ?? [])];
    if (list.length) allErrors[f] = list;
  }
  if (clientErrors.milestones?.length || serverErrors.milestones?.length) allErrors.milestones = [...(clientErrors.milestones ?? []), ...(serverErrors.milestones ?? [])];
  const blocked = ProjectFormModel.hasErrors(allErrors);
  const visiblyBlocked = ProjectFormModel.ORDER.some((f) => shown(f).length > 0) || milestoneMessages.length > 0 || Object.keys(msStepErrors).length > 0;

  const set = (f: FormField, v: string) => {
    setValues((prev) => ({ ...prev, [f]: v }));
    setServerErrors((prev) => (prev[f] ? { ...prev, [f]: undefined } : prev));
    setFormError(null);
  };
  const touch = (f: FormField) => setTouched((t) => (t[f] ? t : { ...t, [f]: true }));

  const scrollToFirstError = (errors: FieldErrors) => {
    const first = ProjectFormModel.firstErrorField(errors) ?? (errors.milestones?.length ? "nextMilestone" : null);
    if (!first) return;
    requestAnimationFrame(() => {
      const el = bodyRef.current?.querySelector<HTMLElement>(`[data-field="${first}"]`);
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
      el?.querySelector<HTMLElement>("input,select,textarea")?.focus({ preventScroll: true });
    });
  };

  const save = async () => {
    setAttempted(true);
    if (blocked) return scrollToFirstError(allErrors);
    if (!isNew && !dirty) return onSaved(""); // nothing to save: back to the detail view
    setSaving(true);
    setFormError(null);
    try {
      const result = await onSubmit(isNew ? values : ProjectFormModel.changes(values, original), MilestoneEditorModel.edit(ms, msOriginal));
      if (result.ok) return onSaved(result.id);
      setFormError(result.error);
      if (result.fieldErrors) {
        setServerErrors(result.fieldErrors);
        scrollToFirstError(result.fieldErrors);
      }
    } catch {
      setFormError("Could not save the change.");
    } finally {
      setSaving(false);
    }
  };

  const hint = ProjectFormModel.accomplishmentHint(values);

  return (
    <>
      <div ref={bodyRef} className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 pt-1 pb-5" data-testid="edit-form">
        <Section title="Project">
          <Field field="name" label="Name" errors={shown("name")}>
            <input
              id="pf-name"
              className={INPUT}
              value={values.name}
              maxLength={ProjectFormModel.maxLength("name")}
              onChange={(e) => set("name", e.target.value)}
              onBlur={() => touch("name")}
              autoFocus={isNew}
            />
          </Field>
          <Field field="serviceArea" label="Department" errors={shown("serviceArea")}>
            <select id="pf-serviceArea" className={INPUT} value={values.serviceArea} onChange={(e) => set("serviceArea", e.target.value)} onBlur={() => touch("serviceArea")}>
              {(isNew || values.serviceArea === "") && <option value="">{isNew ? "Select a department" : ServiceAreaInfo.UNASSIGNED}</option>}
              {ServiceAreaInfo.all().map((a) => (
                <option key={a} value={a}>
                  {ServiceAreaInfo.label(a)}
                </option>
              ))}
              {!isNew && values.serviceArea !== "" && <option value="">{ServiceAreaInfo.UNASSIGNED}</option>}
            </select>
          </Field>
          <Field field="status" label="Status" errors={shown("status")}>
            <select
              id="pf-status"
              className={INPUT}
              value={values.status}
              onChange={(e) => {
                const next = ProjectFormModel.withStatus(values, e.target.value, original, today);
                setValues(next);
                setServerErrors((prev) => ({ ...prev, status: undefined, completedOn: undefined }));
              }}
            >
              {ProjectStatusInfo.all().map((s) => (
                <option key={s} value={s}>
                  {ProjectStatusInfo.label(s)}
                </option>
              ))}
            </select>
          </Field>
          {ProjectFormModel.showsCompletedOn(values) && (
            <Field field="completedOn" label="Completed on" errors={shown("completedOn")}>
              <input id="pf-completedOn" type="date" className={INPUT} value={values.completedOn} onChange={(e) => set("completedOn", e.target.value)} />
            </Field>
          )}
          <Field field="inforRequestNumber" label="Infor number" errors={shown("inforRequestNumber")}>
            <div className="flex h-8 items-center rounded-control border border-line bg-input pl-2.5 focus-within:border-accent">
              <span className="font-mono text-muted type-table" aria-hidden>
                {InforNumber.PREFIX}
              </span>
              <input
                id="pf-inforRequestNumber"
                aria-label="Infor number, digits after REQ-"
                className="h-full min-w-0 flex-1 bg-transparent pr-2.5 font-mono text-fg type-table focus:outline-none"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={ProjectFormModel.INFOR_DIGITS}
                value={values.inforRequestNumber}
                onChange={(e) => set("inforRequestNumber", ProjectFormModel.inforDigits(e.target.value))}
                onBlur={() => touch("inforRequestNumber")}
              />
            </div>
          </Field>
        </Section>

        <Section title="Progress">
          <MilestonesEditor
            state={ms}
            original={msOriginal}
            templates={templates}
            today={today}
            onChange={(next) => {
              setMs(next);
              setServerErrors((prev) => (prev.milestones || prev.nextMilestone || prev.dueDate ? { ...prev, milestones: undefined, nextMilestone: undefined, dueDate: undefined } : prev));
              setFormError(null);
            }}
            errors={milestoneMessages}
          />
          <div className="grid grid-cols-2 gap-3">
            <Field field="percentComplete" label="% complete" errors={shown("percentComplete")}>
              <input
                id="pf-percentComplete"
                className={INPUT}
                inputMode="numeric"
                maxLength={3}
                value={values.percentComplete}
                onChange={(e) => set("percentComplete", e.target.value.replace(/\D+/g, ""))}
                onBlur={() => touch("percentComplete")}
              />
            </Field>
          </div>
        </Section>

        <Section title="Notes">
          <Field field="note" label="Latest update" errors={shown("note")} value={values.note} grandfathered={ProjectFormModel.isGrandfathered("note", values, original)}>
            <textarea id="pf-note" rows={4} className={TEXTAREA} value={values.note} maxLength={ProjectFormModel.maxLength("note")} onChange={(e) => set("note", e.target.value)} />
          </Field>
          <Field
            field="accomplishment"
            label="Accomplishment"
            errors={shown("accomplishment")}
            value={values.accomplishment}
            hint={hint}
            grandfathered={ProjectFormModel.isGrandfathered("accomplishment", values, original)}
          >
            <textarea
              id="pf-accomplishment"
              rows={2}
              className={TEXTAREA}
              value={values.accomplishment}
              maxLength={ProjectFormModel.maxLength("accomplishment")}
              onChange={(e) => set("accomplishment", e.target.value)}
            />
          </Field>
          <Field
            field="description"
            label="Description"
            errors={shown("description")}
            value={values.description}
            grandfathered={ProjectFormModel.isGrandfathered("description", values, original)}
          >
            <textarea
              id="pf-description"
              rows={4}
              className={TEXTAREA}
              value={values.description}
              maxLength={ProjectFormModel.maxLength("description")}
              onChange={(e) => set("description", e.target.value)}
            />
          </Field>
        </Section>

        {people && (
          <Section title="People" caption="Saves as you pick">
            {people}
          </Section>
        )}

        {adminDelete && (
          <div className="border-t border-line pt-4">
            <Section title="Admin">{adminDelete}</Section>
          </div>
        )}
      </div>

      <footer className="flex shrink-0 items-center gap-2 border-t border-line px-6 py-3">
        {confirmDiscard ? (
          <>
            <span className="flex-1 type-table-strong" role="alert">
              {ProjectFormModel.DISCARD_PROMPT}
            </span>
            <button type="button" onClick={onKeepEditing} className="h-7 rounded-control px-2.5 text-muted type-table-strong hover:text-fg">
              Keep editing
            </button>
            <button type="button" onClick={onDiscard} className="h-7 rounded-control bg-(--status-off-track-dark-bg) px-2.5 text-danger type-table-strong">
              Discard
            </button>
          </>
        ) : (
          <>
            <span className="min-w-0 flex-1 truncate text-danger type-table" role={formError ? "alert" : undefined}>
              {formError ?? ""}
            </span>
            <button type="button" onClick={onCancel} className="h-7 rounded-control border border-line px-3 text-muted type-table-strong hover:text-fg">
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={saving}
              aria-disabled={visiblyBlocked || saving}
              className="h-7 rounded-control bg-accent px-3.5 text-white type-table-strong aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </>
        )}
      </footer>
    </>
  );
}

function Section({ title, caption, children }: { title: string; caption?: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-3">
      <div>
        <h3 className="uppercase tracking-[.04em] text-muted type-label">{title}</h3>
        {caption && <p className="mt-0.5 text-muted type-caption">{caption}</p>}
      </div>
      {children}
    </section>
  );
}

/**
 * Label, input, then one line under the input: errors or hint on the left, the "n/limit" counter on
 * the right (12px secondary; overdue color at a hard limit, past a soft limit, or when a stored value
 * is already over a hard cap).
 */
function Field({
  field,
  label,
  errors,
  value,
  hint,
  grandfathered,
  children,
}: {
  field: FormField;
  label: string;
  errors: string[];
  /** Pass for a field with a counter. */
  value?: string;
  hint?: string | null;
  grandfathered?: boolean;
  children: ReactNode;
}) {
  const counter = value === undefined ? null : ProjectFormModel.counter(field, value);
  const softWarning = counter?.kind === "soft" && counter.alert;
  const hasLine = errors.length > 0 || counter || hint;
  return (
    <div data-field={field} className="flex min-w-0 flex-col gap-1">
      <label htmlFor={`pf-${field}`} className="text-muted type-caption">
        {label}
      </label>
      {children}
      {hasLine && (
        <div className="flex items-start gap-3 type-table">
          <div className="min-w-0 flex-1">
            {errors.map((m) => (
              <p key={m} className="text-danger">
                {m}
              </p>
            ))}
            {errors.length === 0 && softWarning && <p className="text-danger">Over {counter.limit} characters; it may be cut off in the report</p>}
            {errors.length === 0 && grandfathered && <p className="text-danger">Over the limit; shorten it if you edit this field</p>}
            {errors.length === 0 && !softWarning && !grandfathered && hint && <p className="text-muted">{hint}</p>}
          </div>
          {counter && (
            <span data-testid={`counter-${field}`} className={`shrink-0 tabular-nums ${counter.alert ? "text-danger" : "text-muted"}`}>
              {counter.count}/{counter.limit}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
