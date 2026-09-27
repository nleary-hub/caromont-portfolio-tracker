"use client";

import { useActionState, useMemo, useState } from "react";
import { saveReportColors } from "@/app/actions/reports";
import { ReportColorScheme, type ReportColorsValue, type ResolvedReportColors } from "@/lib/report/ReportColorScheme";
import type { ReportColorsFormState } from "@/lib/services/ReportOptionsForm";

const INPUT = "h-8 w-[110px] min-w-0 rounded-control border border-line bg-input px-2.5 font-mono text-fg type-table focus:border-accent focus:outline-none";
const COPY = ReportColorScheme.COPY;

type Choice = { key: string; hex: string };

/** A stored value ("navy", "none" or "#2B4C7E") to the picker state. */
function choiceOf(stored: string, fallbackHex: string): Choice {
  return stored.startsWith("#") ? { key: ReportColorScheme.CUSTOM, hex: stored } : { key: stored, hex: fallbackHex };
}

function valueOf(c: Choice): string | null {
  return c.key === ReportColorScheme.CUSTOM ? ReportColorScheme.hex(c.hex) : c.key;
}

/**
 * Admin > Report contents > Report colors: department bar color and the page 1 title band, each a preset or a custom
 * color, with a live preview of the top of page 1. A custom color whose text would fail WCAG AA is blocked here
 * (and again on the server).
 */
export function ReportColorsForm({ colors }: { colors: ReportColorsValue }) {
  const [state, action, pending] = useActionState<ReportColorsFormState, FormData>(saveReportColors, null);
  const [bar, setBar] = useState<Choice>(() => choiceOf(colors.bar, "#2B4C7E"));
  const [band, setBand] = useState<Choice>(() => choiceOf(colors.band, "#2B4C7E"));

  const barError = bar.key === ReportColorScheme.CUSTOM ? ReportColorScheme.check(bar.hex) : { ok: true as const };
  const bandError = band.key === ReportColorScheme.CUSTOM ? ReportColorScheme.check(band.hex) : { ok: true as const };
  const blocked = !barError.ok || !bandError.ok;
  const serverField = state && !state.ok ? state.field : undefined;

  // Preview: the last valid choice of each (a blocked custom color previews as the saved value).
  const preview: ResolvedReportColors = useMemo(() => {
    const b = barError.ok ? valueOf(bar) : null;
    const h = bandError.ok ? valueOf(band) : null;
    return ReportColorScheme.resolve({ bar: b ?? colors.bar, band: h ?? colors.band });
  }, [bar, band, barError.ok, bandError.ok, colors]);

  return (
    <form action={action} className="flex flex-col gap-4" data-testid="report-colors-form">
      <p className="type-caption text-muted">{COPY.intro}</p>
      <div className="flex flex-wrap items-start gap-6">
        <div className="flex min-w-[340px] flex-1 flex-col gap-4">
          <ColorChoice
            legend={COPY.barLegend}
            name="bar"
            choice={bar}
            onChange={setBar}
            withNone={false}
            error={!barError.ok ? barError.message : serverField === "bar" && state && !state.ok ? state.message : null}
            warning={barError.ok && bar.key === ReportColorScheme.CUSTOM && ReportColorScheme.nearStatus(bar.hex) ? COPY.statusWarning : null}
          />
          <ColorChoice
            legend={COPY.bandLegend}
            name="band"
            choice={band}
            onChange={setBand}
            withNone
            help={COPY.bandHelp}
            error={!bandError.ok ? bandError.message : serverField === "band" && state && !state.ok ? state.message : null}
            warning={bandError.ok && band.key === ReportColorScheme.CUSTOM && ReportColorScheme.nearStatus(band.hex) ? COPY.statusWarning : null}
          />
        </div>
        <PagePreview colors={preview} />
      </div>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending || blocked}
          className="h-8 rounded-control bg-accent px-3.5 text-white type-table-strong disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          className="text-accent type-table-strong hover:underline"
          onClick={() => {
            setBar({ key: ReportColorScheme.DEFAULTS.bar, hex: bar.hex });
            setBand({ key: ReportColorScheme.DEFAULTS.band, hex: band.hex });
          }}
        >
          {COPY.reset}
        </button>
        {state && (state.ok || !state.field) && (
          <span role="status" className={`type-caption ${state.ok ? "text-muted" : "text-danger"}`}>
            {state.message}
          </span>
        )}
      </div>
      <p className="type-caption text-muted">{COPY.footnote}</p>
    </form>
  );
}

function ColorChoice({
  legend,
  name,
  choice,
  onChange,
  withNone,
  help,
  error,
  warning,
}: {
  legend: string;
  name: "bar" | "band";
  choice: Choice;
  onChange: (c: Choice) => void;
  withNone: boolean;
  help?: string;
  error: string | null;
  warning: string | null;
}) {
  const keys = [...(withNone ? [ReportColorScheme.NONE] : []), ...ReportColorScheme.PRESET_KEYS, ReportColorScheme.CUSTOM];
  const label = (k: string) => (k === ReportColorScheme.NONE ? COPY.none : k === ReportColorScheme.CUSTOM ? COPY.custom : ReportColorScheme.PRESETS[k as keyof typeof ReportColorScheme.PRESETS].label);
  const swatch = (k: string) => (ReportColorScheme.isPreset(k) ? ReportColorScheme.PRESETS[k].bar.fill : null);
  const pickerValue = ReportColorScheme.hex(choice.hex) ?? "#2B4C7E";
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1 type-label text-muted">{legend}</legend>
      <input type="hidden" name={name} value={choice.key} />
      <div role="radiogroup" aria-label={legend} className="vp-seg" style={{ gridTemplateColumns: `repeat(${keys.length}, auto)`, maxWidth: withNone ? 470 : 390 }}>
        {keys.map((k) => (
          <button key={k} type="button" role="radio" aria-checked={choice.key === k} className={`px-2.5 ${choice.key === k ? "vp-act" : ""}`} onClick={() => onChange({ ...choice, key: k })}>
            <span className="inline-flex items-center gap-1.5">
              {swatch(k) && <span aria-hidden className="inline-block size-2.5 rounded-[3px] border border-white/20" style={{ background: swatch(k)! }} />}
              {label(k)}
            </span>
          </button>
        ))}
      </div>
      {choice.key === ReportColorScheme.CUSTOM && (
        <div className="flex items-center gap-2">
          <input
            type="color"
            aria-label={`${legend}: ${COPY.pickerLabel}`}
            value={pickerValue}
            onChange={(e) => onChange({ ...choice, hex: e.target.value.toUpperCase() })}
            className="h-8 w-10 cursor-pointer rounded-control border border-line bg-input p-0.5"
          />
          <input
            name={`${name}Hex`}
            aria-label={`${legend}: ${COPY.hexLabel}`}
            aria-invalid={Boolean(error)}
            className={INPUT}
            value={choice.hex}
            maxLength={7}
            spellCheck={false}
            onChange={(e) => onChange({ ...choice, hex: e.target.value })}
          />
          {!error && <span className="text-[12px] leading-4 text-(--dark-text-secondary)">{COPY.contrastNote}</span>}
        </div>
      )}
      {error ? (
        <p className="text-[12px] leading-4 text-danger" role="alert" data-testid={`${name}-error`}>
          {error}
        </p>
      ) : warning ? (
        <p className="text-[12px] leading-4 text-(--status-at-risk-dark-fg)" role="status" data-testid={`${name}-warning`}>
          {warning}
        </p>
      ) : (
        help && <p className="text-[12px] leading-4 text-(--dark-text-secondary)">{help}</p>
      )}
    </fieldset>
  );
}

/** Top of page 1 at small scale: eyebrow, title, EXAMPLE DATA tag, the rule and one department bar (same colors as the PDF). */
function PagePreview({ colors }: { colors: ResolvedReportColors }) {
  const { bar, band } = colors;
  return (
    <figure className="flex flex-col gap-1.5" aria-label={COPY.preview}>
      <figcaption className="type-label text-muted">{COPY.preview}</figcaption>
      <div className="w-[340px] rounded-[6px] bg-white px-[18px] pt-[14px] pb-[16px] shadow-[0_8px_24px_rgba(0,0,0,.35)]" data-testid="report-colors-preview">
        <div className="relative">
          {band && <div className="absolute" style={{ left: -4, right: -4, top: -4, bottom: 0, background: band.fill }} />}
          <div className="relative flex items-start justify-between px-0 pt-0 pb-[6px]">
            <div>
              <div className="text-[6.5px] font-semibold tracking-[.06em]" style={{ color: band?.eyebrow ?? "#5B6270" }}>
                CARDIOVASCULAR &amp; PULMONARY SERVICE LINE
              </div>
              <div className="text-[13px] leading-[16px] font-bold" style={{ color: band?.title ?? "#15171C" }}>
                Project Status Report
              </div>
            </div>
            <span className="rounded-[2px] border border-[#D9DCE1] bg-white px-1 text-[5.5px] leading-[9px] font-semibold tracking-[.04em] text-[#5B6270]">EXAMPLE DATA</span>
          </div>
          <div className="relative h-[1.5px]" style={{ background: band?.rule ?? "#15171C", marginLeft: band ? -4 : 0, marginRight: band ? -4 : 0 }} />
        </div>
        <div className="mt-[8px] flex gap-2">
          <div className="h-[5px] w-[90px] rounded-[1px] bg-[#E9EBEF]" />
          <div className="h-[5px] w-[120px] rounded-[1px] bg-[#E9EBEF]" />
        </div>
        <div className="mt-[10px] flex h-[13px] items-center justify-between pr-[4px]" style={{ background: bar.fill, borderLeft: `2px solid ${bar.stripe}` }} data-testid="preview-bar">
          <span className="pl-[4px] text-[7.5px] font-semibold" style={{ color: bar.text }}>
            Cath
          </span>
          <span className="text-[6px]" style={{ color: bar.count }}>
            4 projects
          </span>
        </div>
        <div className="mt-[5px] flex flex-col gap-[4px]">
          <div className="h-[4px] w-[250px] rounded-[1px] bg-[#EEF0F3]" />
          <div className="h-[4px] w-[210px] rounded-[1px] bg-[#EEF0F3]" />
        </div>
      </div>
    </figure>
  );
}
