"use client";

import { useActionState } from "react";
import { saveServiceLine } from "@/app/actions/serviceLine";
import { ServiceLine, type ServiceLineValue } from "@/lib/domain/ServiceLine";
import type { ServiceLineFormState } from "@/lib/services/ServiceLineForm";

/** Admin only (the page 404s for everyone else; the action re-checks). */
export function ServiceLineSettingsForm({ value }: { value: ServiceLineValue }) {
  const [state, action, pending] = useActionState<ServiceLineFormState, FormData>(saveServiceLine, null);
  const errors = state && !state.ok ? (state.errors ?? {}) : {};
  const input = "h-8 w-full rounded-control border border-line bg-input px-2.5 type-table text-fg focus:border-accent focus:outline-none";
  return (
    <form action={action} className="flex max-w-[520px] flex-col gap-3">
      <label className="flex flex-col gap-1">
        <span className="type-label text-muted">Service line name</span>
        <input
          name="name"
          defaultValue={value.name}
          required
          maxLength={ServiceLine.NAME_MAX_LENGTH}
          aria-invalid={errors.name ? true : undefined}
          aria-describedby="sl-name-help"
          className={input}
        />
        <span id="sl-name-help" className={`type-caption ${errors.name ? "text-danger" : "text-muted"}`}>
          {errors.name ?? `Shown in the top bar and the report title. Up to ${ServiceLine.NAME_MAX_LENGTH} characters.`}
        </span>
      </label>
      <label className="flex flex-col gap-1">
        <span className="type-label text-muted">Short name</span>
        <input
          name="shortName"
          defaultValue={value.shortName}
          required
          maxLength={ServiceLine.SHORT_MAX_LENGTH}
          aria-invalid={errors.shortName ? true : undefined}
          aria-describedby="sl-short-help"
          className={`${input} max-w-[160px]`}
        />
        <span id="sl-short-help" className={`type-caption ${errors.shortName ? "text-danger" : "text-muted"}`}>
          {errors.shortName ?? `Shown on narrow screens. Up to ${ServiceLine.SHORT_MAX_LENGTH} characters.`}
        </span>
      </label>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="h-8 rounded-control bg-accent px-3.5 text-white type-table-strong disabled:opacity-60"
        >
          {pending ? "Saving…" : "Save"}
        </button>
        {state && (
          <span role="status" className={`type-caption ${state.ok ? "text-muted" : "text-danger"}`}>
            {state.message}
          </span>
        )}
      </div>
      <p className="type-caption text-muted">
        Frozen reports keep the name they were frozen with. The next freeze and drafts use the new name.
      </p>
    </form>
  );
}
