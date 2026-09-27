"use client";

import { useState, useTransition } from "react";
import type { ServiceArea } from "@/generated/prisma/enums";
import { saveContractsLeads, saveLineDepartments } from "@/app/actions/serviceLine";
import { ServiceAreaInfo } from "@/lib/domain/ServiceAreaInfo";
import type { ServiceLineActionResult } from "@/lib/services/ServiceLineForms";
import { SmallCheck } from "./DashboardFilterControls";

function Result({ state }: { state: ServiceLineActionResult | null }) {
  if (!state) return null;
  return (
    <span role="status" className={`type-caption ${state.ok ? "text-muted" : "text-danger"}`}>
      {state.message}
    </span>
  );
}

const SAVE = "h-8 rounded-control bg-accent px-3.5 text-white type-table-strong disabled:opacity-60";

/** Departments a (non-default) line uses: a subset of the seven, in report order. */
export function LineDepartmentsForm({ lineId, departments }: { lineId: string; departments: readonly ServiceArea[] }) {
  const [selected, setSelected] = useState<ServiceArea[]>([...departments]);
  const [state, setState] = useState<ServiceLineActionResult | null>(null);
  const [pending, start] = useTransition();
  const toggle = (a: ServiceArea) => setSelected((s) => ServiceAreaInfo.all().filter((x) => (x === a ? !s.includes(a) : s.includes(x))));
  return (
    <form
      className="flex max-w-[520px] flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => setState(await saveLineDepartments(lineId, selected)));
      }}
    >
      <ul className="vp-list max-w-[260px]" aria-label="Departments">
        {ServiceAreaInfo.all().map((a) => (
          <li key={a}>
            <label className="vp-check">
              <input type="checkbox" className="sr-only" name="departments" value={a} checked={selected.includes(a)} onChange={() => toggle(a)} />
              <SmallCheck on={selected.includes(a)} />
              <span className="vp-lbl">{ServiceAreaInfo.label(a)}</span>
            </label>
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className={SAVE}>
          {pending ? "Saving…" : "Save"}
        </button>
        <Result state={state} />
      </div>
      <p className="type-caption text-muted">Offered in the project Department field, the dashboard filter and the report. Projects keep a department that is later removed.</p>
    </form>
  );
}

/** A line's contracts lead pick-list, one name per line. */
export function ContractsLeadsForm({ lineId, leads }: { lineId: string; leads: readonly string[] }) {
  const [text, setText] = useState(leads.join("\n"));
  const [state, setState] = useState<ServiceLineActionResult | null>(null);
  const [pending, start] = useTransition();
  return (
    <form
      className="flex max-w-[520px] flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => setState(await saveContractsLeads(lineId, text)));
      }}
    >
      <label className="flex flex-col gap-1">
        <span className="type-label text-muted">Contracts leads</span>
        <textarea
          name="contractsLeads"
          value={text}
          rows={Math.max(4, text.split("\n").length + 1)}
          onChange={(e) => setText(e.target.value)}
          className="block w-full resize-y rounded-control border border-line bg-input px-2.5 py-2 text-fg type-table focus:border-accent focus:outline-none"
        />
        <span className="type-caption text-muted">One name per line, in the order the pick-list shows them. Projects keep a lead that is later removed.</span>
      </label>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className={SAVE}>
          {pending ? "Saving…" : "Save"}
        </button>
        <Result state={state} />
      </div>
    </form>
  );
}
