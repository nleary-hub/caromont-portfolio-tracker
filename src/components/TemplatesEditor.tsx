"use client";

import { useState } from "react";
import {
  addTemplateItem,
  createTemplate,
  deleteTemplate,
  deleteTemplateItem,
  renameTemplate,
  renameTemplateItem,
  reorderTemplateItems,
  reorderTemplates,
  type TemplateActionResult,
} from "@/app/actions/milestoneTemplates";
import { MilestoneRules } from "@/lib/domain/MilestoneRules";
import { MilestoneEditorModel } from "@/lib/projects/MilestoneEditorModel";
import type { TemplateDto } from "@/lib/services/MilestoneTemplateService";

const INPUT =
  "h-8 w-full min-w-0 rounded-control border border-line bg-input px-2.5 text-fg type-table focus:border-accent focus:outline-none";

/** Reorders a list by moving one entry (drag and drop or keyboard). */
class ListOrder {
  static move<T>(list: readonly T[], from: number, to: number): T[] {
    const next = [...list];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    return next;
  }
}

/**
 * Admin Templates page: list on the left (milestone count only), detail on the right. Every edit autosaves
 * through an admin-checked, audited server action. Templates are copied into projects when applied, so
 * nothing here changes an existing project.
 */
export function TemplatesEditor({ initial }: { initial: TemplateDto[] }) {
  const [templates, setTemplates] = useState(initial);
  const [selectedId, setSelectedId] = useState<string | null>(
    initial[0]?.id ?? null,
  );
  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(
    null,
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [newStep, setNewStep] = useState("");
  const [renaming, setRenaming] = useState<{
    id: string;
    length: number;
  } | null>(null);
  const [drag, setDrag] = useState<{
    list: "templates" | "items";
    from: number;
  } | null>(null);

  const selected = templates.find((t) => t.id === selectedId) ?? null;

  const run = async (
    p: Promise<TemplateActionResult>,
    done?: (r: Extract<TemplateActionResult, { ok: true }>) => void,
  ) => {
    setStatus({ text: "Saving…", error: false });
    const r = await p;
    if (!r.ok) {
      setStatus({ text: r.error, error: true });
      return;
    }
    setTemplates(r.templates);
    setStatus({ text: "Saved", error: false });
    done?.(r);
  };

  const moveTemplates = (from: number, to: number) => {
    const next = ListOrder.move(templates, from, to);
    setTemplates(next);
    void run(reorderTemplates(next.map((t) => t.id)));
  };
  const moveItems = (from: number, to: number) => {
    if (!selected) return;
    const items = ListOrder.move(selected.items, from, to);
    setTemplates(
      templates.map((t) => (t.id === selected.id ? { ...t, items } : t)),
    );
    void run(
      reorderTemplateItems(
        selected.id,
        items.map((i) => i.id),
      ),
    );
  };
  const keyMove = (
    list: "templates" | "items",
    i: number,
    count: number,
    key: string,
    id: string,
  ) => {
    const to = MilestoneEditorModel.keyMove(i, key, count);
    if (to === null) return false;
    if (list === "templates") moveTemplates(i, to);
    else moveItems(i, to);
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLButtonElement>(
          `[data-handle-id="${CSS.escape(id)}"]`,
        )
        ?.focus(),
    );
    return true;
  };

  const handle = (
    id: string,
    label: string,
    onKey: (key: string) => boolean,
    onDragStart: () => void,
  ) => (
    <button
      type="button"
      data-handle-id={id}
      draggable
      onDragStart={onDragStart}
      onDragEnd={() => setDrag(null)}
      onKeyDown={(e) => {
        if (onKey(e.key)) e.preventDefault();
      }}
      aria-label={`Reorder ${label}. Use the arrow keys to move it.`}
      className="flex h-6 w-4 shrink-0 cursor-grab items-center justify-center text-muted hover:text-fg focus:text-fg focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
    >
      <svg
        width="8"
        height="14"
        viewBox="0 0 8 14"
        aria-hidden
        fill="currentColor"
      >
        {[1, 5, 9, 13].map((y) => (
          <g key={y}>
            <circle cx="2" cy={y} r="1" />
            <circle cx="6" cy={y} r="1" />
          </g>
        ))}
      </svg>
    </button>
  );

  return (
    <div className="flex flex-col gap-4" data-testid="templates-editor">
      <div className="flex items-center justify-end">
        <button
          type="button"
          onClick={() =>
            run(
              createTemplate("New template"),
              (r) => r.createdId && setSelectedId(r.createdId),
            )
          }
          className="h-7 rounded-control bg-accent px-3 text-white type-table-strong"
        >
          + New template
        </button>
      </div>
      <div className="grid grid-cols-[300px_1fr] items-start gap-4">
        <section
          aria-label="Templates"
          className="flex flex-col rounded-card border border-line bg-card p-1.5"
        >
          <ol className="flex flex-col">
            {templates.map((t, i) => (
              <li
                key={t.id}
                onDragOver={(e) =>
                  drag?.list === "templates" && e.preventDefault()
                }
                onDrop={() => {
                  if (drag?.list === "templates") moveTemplates(drag.from, i);
                  setDrag(null);
                }}
                className={`flex items-center gap-2 rounded-control px-2 py-2.5 ${t.id === selectedId ? "bg-row-selected shadow-[inset_2px_0_0_var(--dark-accent)]" : "hover:bg-input"}`}
              >
                {handle(
                  t.id,
                  t.name,
                  (key) => keyMove("templates", i, templates.length, key, t.id),
                  () => setDrag({ list: "templates", from: i }),
                )}
                <button
                  type="button"
                  onClick={() => {
                    setSelectedId(t.id);
                    setConfirmDelete(false);
                  }}
                  aria-current={t.id === selectedId ? "true" : undefined}
                  className="flex min-w-0 flex-1 items-center justify-between gap-2 text-left"
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate text-fg type-table-strong">
                      {t.name}
                    </span>
                    <span className="tabular-nums text-muted type-caption">
                      {t.items.length}{" "}
                      {t.items.length === 1 ? "milestone" : "milestones"}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ol>
          <p className="px-2.5 pt-2 pb-1 text-muted type-caption">
            Drag to set the order of the Apply template list.
          </p>
        </section>

        <section
          aria-label="Template detail"
          className="flex min-w-0 flex-col gap-2 rounded-card border border-line bg-card px-[18px] py-4"
        >
          {!selected ? (
            <p className="text-muted type-table">No templates yet.</p>
          ) : (
            <>
              <div className="flex items-center gap-3">
                <input
                  aria-label="Template name"
                  key={`name-${selected.id}-${selected.name}`}
                  defaultValue={selected.name}
                  maxLength={MilestoneRules.TEMPLATE_NAME_MAX}
                  className={`${INPUT} max-w-[320px] type-heading`}
                  onBlur={(e) =>
                    e.target.value.trim() !== selected.name &&
                    run(renameTemplate(selected.id, e.target.value))
                  }
                  onKeyDown={(e) =>
                    e.key === "Enter" && (e.target as HTMLInputElement).blur()
                  }
                />
                <span className="flex-1 text-muted type-caption">
                  Click the name to rename
                </span>
                {!confirmDelete && (
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(true)}
                    className="h-7 shrink-0 rounded-control px-2.5 text-danger type-table-strong hover:bg-input"
                  >
                    Delete template
                  </button>
                )}
              </div>
              {confirmDelete && (
                <div
                  role="alertdialog"
                  aria-label="Delete template"
                  className="flex flex-wrap items-center gap-2 rounded-control border border-line bg-input px-3 py-2"
                >
                  <span className="flex-1 text-fg type-table">
                    Delete &lsquo;{selected.name}&rsquo; and its{" "}
                    {selected.items.length} milestones? Projects that already
                    used it keep their milestones.
                  </span>
                  <button
                    type="button"
                    onClick={() => setConfirmDelete(false)}
                    className="h-7 rounded-control px-2.5 text-muted type-table-strong hover:text-fg"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      run(deleteTemplate(selected.id), (r) => {
                        setConfirmDelete(false);
                        setSelectedId(r.templates[0]?.id ?? null);
                      })
                    }
                    className="h-7 rounded-control bg-(--status-off-track-dark-bg) px-2.5 text-danger type-table-strong"
                  >
                    Delete template
                  </button>
                </div>
              )}
              <p className="text-muted type-caption">
                Applying copies these steps into the project. Editing the
                template later doesn&rsquo;t change projects that already used
                it.
              </p>
              <span className="mt-1 uppercase tracking-[.06em] text-muted type-label">
                Milestones, in order
              </span>
              <ol
                className="flex flex-col"
                aria-label={`${selected.name} steps`}
              >
                {selected.items.map((it, i) => (
                  <li
                    key={it.id}
                    onDragOver={(e) =>
                      drag?.list === "items" && e.preventDefault()
                    }
                    onDrop={() => {
                      if (drag?.list === "items") moveItems(drag.from, i);
                      setDrag(null);
                    }}
                    className="flex h-9 items-center gap-2.5 border-b border-line px-2.5"
                  >
                    {handle(
                      it.id,
                      it.name,
                      (key) =>
                        keyMove("items", i, selected.items.length, key, it.id),
                      () => setDrag({ list: "items", from: i }),
                    )}
                    <span className="w-5 shrink-0 text-right tabular-nums text-muted type-caption">
                      {i + 1}
                    </span>
                    <input
                      key={`${it.id}-${it.name}`}
                      id={`tpl-item-${it.id}`}
                      defaultValue={it.name}
                      maxLength={MilestoneRules.TEMPLATE_STEP_MAX}
                      aria-label={`Step ${i + 1} name`}
                      className="h-7 min-w-0 flex-1 rounded-control border border-transparent bg-transparent px-1.5 text-fg type-table hover:border-line focus:border-accent focus:bg-input focus:outline-none"
                      onFocus={(e) =>
                        setRenaming({
                          id: it.id,
                          length: e.target.value.length,
                        })
                      }
                      onChange={(e) =>
                        setRenaming({
                          id: it.id,
                          length: e.target.value.length,
                        })
                      }
                      onBlur={(e) => {
                        setRenaming(null);
                        if (e.target.value.trim() !== it.name)
                          void run(renameTemplateItem(it.id, e.target.value));
                      }}
                      onKeyDown={(e) =>
                        e.key === "Enter" &&
                        (e.target as HTMLInputElement).blur()
                      }
                    />
                    {renaming?.id === it.id ? (
                      <span
                        className="shrink-0 tabular-nums text-muted type-caption"
                        data-testid="template-rename-counter"
                      >
                        {renaming.length}/{MilestoneRules.TEMPLATE_STEP_MAX}
                      </span>
                    ) : (
                      <button
                        type="button"
                        aria-label={`Rename step ${it.name}`}
                        onClick={() =>
                          document.getElementById(`tpl-item-${it.id}`)?.focus()
                        }
                        className="h-[22px] shrink-0 rounded-control px-1.5 text-muted type-caption hover:bg-input hover:text-fg"
                      >
                        Edit
                      </button>
                    )}
                    <button
                      type="button"
                      aria-label={`Delete step ${it.name}`}
                      onClick={() => run(deleteTemplateItem(it.id))}
                      className="flex h-[22px] w-6 shrink-0 items-center justify-center rounded-control text-muted hover:bg-input hover:text-danger"
                    >
                      &times;
                    </button>
                  </li>
                ))}
              </ol>
              <div className="flex items-center gap-2">
                <input
                  value={newStep}
                  onChange={(e) => setNewStep(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && newStep.trim()) {
                      e.preventDefault();
                      void run(addTemplateItem(selected.id, newStep), () =>
                        setNewStep(""),
                      );
                    }
                  }}
                  placeholder="Add a milestone and press Enter"
                  aria-label="New step name"
                  maxLength={MilestoneRules.TEMPLATE_STEP_MAX}
                  className={INPUT}
                />
                <span className="shrink-0 tabular-nums text-muted type-caption">
                  {newStep.length}/{MilestoneRules.TEMPLATE_STEP_MAX}
                </span>
                <button
                  type="button"
                  disabled={!newStep.trim()}
                  onClick={() =>
                    run(addTemplateItem(selected.id, newStep), () =>
                      setNewStep(""),
                    )
                  }
                  className="h-8 shrink-0 rounded-control border border-line px-3 text-fg type-table-strong disabled:opacity-50"
                >
                  Add
                </button>
              </div>
              <p className="text-muted type-caption">
                Drag &#x22EE;&#x22EE; to reorder (or focus it and use the arrow
                keys). Changes save automatically and are recorded in the change
                log.
              </p>
            </>
          )}
          {status && (
            <p
              role="status"
              className={`type-caption ${status.error ? "text-danger" : "text-muted"}`}
            >
              {status.text}
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
