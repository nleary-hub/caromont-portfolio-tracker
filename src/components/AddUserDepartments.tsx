"use client";

import { useState } from "react";
import { AddUserForm } from "@/components/AccessAccountControls";
import { DepartmentAccessCopy } from "@/lib/access/DepartmentAccessCopy";
import type { AccessLine } from "@/lib/services/LineAccessService";
import type { AccountResult } from "@/lib/services/UserAccountService";

/**
 * Add user with department access (Admin > People > Access): under each checked line, the same "All departments"
 * switch as the grid's panel, on by default. Turning it off checks every open department first (as in the grid), then
 * the admin unchecks the ones they shouldn't see. Unchecking the last department unchecks the line, like the grid
 * (nothing is saved yet, so there is nothing to confirm). Lines, departments and the optional temporary password are
 * one save: the departments reach the server through AddUserForm's extraInput and DepartmentAccessService.addUserHook.
 */
export function AddUserWithDepartments({
  lines,
  onCancel,
  onAdded,
}: {
  lines: AccessLine[];
  onCancel: () => void;
  onAdded: (r: Extract<AccountResult, { ok: true }>) => void;
}) {
  // Line id to the checked departments, for lines with "All departments" off. Missing = All departments.
  const [limits, setLimits] = useState<Record<string, string[]>>({});
  const setLine = (lineId: string, ids: string[] | null) =>
    setLimits((cur) => {
      const next = { ...cur };
      if (ids) next[lineId] = ids;
      else delete next[lineId];
      return next;
    });

  return (
    <AddUserForm
      lines={lines}
      onCancel={onCancel}
      onAdded={onAdded}
      extraInput={{ departments: limits }}
      lineExtra={(line, checked, setChecked) =>
        checked && line.departments.length > 0 ? (
          <LineDepartments
            line={line}
            chosen={limits[line.id] ?? null}
            onAll={(on) => setLine(line.id, on ? null : line.departments.map((d) => d.id))}
            onDepartment={(id, on) => {
              const cur = limits[line.id] ?? [];
              const next = on ? [...cur.filter((x) => x !== id), id] : cur.filter((x) => x !== id);
              if (next.length === 0) {
                setLine(line.id, null);
                setChecked(false);
              } else setLine(line.id, next);
            }}
          />
        ) : null
      }
    />
  );
}

function LineDepartments({ line, chosen, onAll, onDepartment }: { line: AccessLine; chosen: string[] | null; onAll: (on: boolean) => void; onDepartment: (id: string, on: boolean) => void }) {
  const all = chosen === null;
  const helpId = `add-user-${line.id}-departments-help`;
  return (
    <div role="group" aria-label={`${line.shortName} ${line.name}`} className="ml-6 flex flex-col gap-2 border-l border-line pl-3" data-add-departments={line.shortName}>
      <div className="flex items-center gap-2.5">
        <button
          type="button"
          role="switch"
          aria-checked={all}
          aria-describedby={helpId}
          onClick={() => onAll(!all)}
          className={`relative inline-flex h-4 w-7 flex-none items-center rounded-full transition-colors ${all ? "bg-accent" : "bg-line"}`}
          data-testid="add-user-all-switch"
        >
          <span className={`inline-block size-3 rounded-full bg-white transition-transform ${all ? "translate-x-3.5" : "translate-x-0.5"}`} />
          <span className="sr-only">{DepartmentAccessCopy.ALL_DEPARTMENTS}</span>
        </button>
        <span className="type-table" aria-hidden="true">
          {DepartmentAccessCopy.ALL_DEPARTMENTS}
        </span>
        <span id={helpId} className="text-muted type-caption">
          {all ? DepartmentAccessCopy.HELPER_ON : DepartmentAccessCopy.HELPER_OFF}
        </span>
      </div>
      {!all && (
        <div className="grid gap-x-4 gap-y-1.5 pl-9" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))" }} data-testid="add-user-departments">
          {line.departments.map((d) => (
            <label key={d.id} className="flex min-w-0 cursor-pointer items-center gap-2 type-table">
              <input type="checkbox" className="size-4 flex-none cursor-pointer accent-accent" checked={chosen.includes(d.id)} onChange={(e) => onDepartment(d.id, e.target.checked)} data-add-department={d.name} />
              <span className="truncate">{d.name}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
