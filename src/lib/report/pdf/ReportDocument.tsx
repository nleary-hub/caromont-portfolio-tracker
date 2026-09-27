import { Circle, Document, Page, Path, Rect, Svg, Text, View } from "@react-pdf/renderer";
import { Fragment } from "react";
import type { ProjectStatus } from "@/generated/prisma/enums";
import { PeopleLabel } from "@/lib/domain/PeopleLabel";
import { ServiceAreaInfo } from "@/lib/domain/ServiceAreaInfo";
import { StatusShapes, type ShapePart } from "@/lib/domain/StatusShapes";
import { ReportFonts } from "@/lib/report/pdf/ReportFonts";
import {
  ReportGeometry as G,
  ReportLayout,
  type BodyBlock,
  type DocumentLayout,
  type FlagBox,
  type HeaderModel,
  type KeyLineModel,
  type KeyModel,
  CompletedBlockStyle,
  type ContractsLine,
  type MetaRun,
  type PageLayout,
  type PillBox,
  type PlacedFlag,
  type RowCell,
  type RowLayout,
} from "@/lib/report/pdf/ReportLayout";

/** Light print palette (src/styles/tokens.css, *-light-*). */
export class ReportColors {
  static readonly TEXT = "#15171C";
  static readonly MUTED = "#5B6270";
  static readonly DIVIDER = "#D9DCE1";
  /** --light-section-bg: kept for anything else that uses the lighter tint. */
  static readonly SECTION_BG = "#F4F5F7";
  /** --light-section-bg-strong: department heading bars (clearly visible in print; text contrast stays high). */
  static readonly SECTION_BG_STRONG = "#E1E5EB";
  static readonly BG = "#FFFFFF";
  static readonly STATUS: Record<ProjectStatus, { bg: string; fg: string }> = {
    NotStarted: { bg: "#E9EBEF", fg: "#3F4550" },
    OnTrack: { bg: "#DBF2E2", fg: "#136A33" },
    AtRisk: { bg: "#FCEFCF", fg: "#855500" },
    OffTrack: { bg: "#FADDDE", fg: "#A0181E" },
    OnHold: { bg: "#E0E7F6", fg: "#2D4B88" },
    Complete: { bg: "#D6F1EE", fg: "#0E6961" },
    Cancelled: { bg: "#F0F1F3", fg: "#737985" },
  };
  static readonly CHANGED = { bg: "#FFFFFF", fg: "#4B2FA8" };
  static readonly OVERDUE = { bg: "#A0181E", fg: "#FFFFFF" };
  /** Stale chip and amber "Updated" date (row-details.html, report rows: dashed #855500). */
  static readonly STALE = { bg: "#FFFFFF", fg: "#855500" };
  static readonly WORSE = "#A0181E";
  static readonly BETTER = "#136A33";
}

const F = ReportFonts.FAMILY;
const C = ReportColors;

function Line({
  x,
  y,
  w,
  text,
  size,
  weight = 400,
  color = C.TEXT,
  lh,
  align = "left",
}: {
  x: number;
  y: number;
  w: number;
  text: string;
  size: number;
  weight?: number;
  color?: string;
  lh: number;
  align?: "left" | "right" | "center";
}) {
  // Lines are pre-wrapped by ReportLayout; the extra width only guards against rounding.
  return (
    <Text
      style={{
        position: "absolute",
        left: align === "right" ? x - 12 : x,
        top: y,
        width: w + 12,
        fontFamily: F,
        fontSize: size,
        fontWeight: weight,
        lineHeight: lh / size,
        color,
        textAlign: align,
        maxLines: 1,
      }}
    >
      {text}
    </Text>
  );
}

/** One run of the project meta line. The Infor number uses built-in Courier at 6.5 pt, baseline-aligned with the 7 pt text. */
function MetaText({ run, x, y, w }: { run: MetaRun; x: number; y: number; w: number }) {
  const mono = run.font === "mono";
  const size = mono ? G.SIZE.mono : G.SIZE.small;
  return (
    <Text
      style={{
        position: "absolute",
        left: x + run.x,
        // Same line box as the 7 pt text; nudge the smaller mono run down so baselines line up.
        top: y + (mono ? (G.SIZE.small - G.SIZE.mono) * 0.8 : 0),
        width: Math.max(1, w - run.x) + 12,
        fontFamily: mono ? "Courier" : F,
        fontSize: size,
        fontWeight: mono ? undefined : run.weight,
        lineHeight: G.SMALL_LH / size,
        color: run.tone === "stale" ? C.STALE.fg : C.MUTED,
        maxLines: 1,
      }}
    >
      {run.text}
    </Text>
  );
}

function ShapeParts({ parts, color }: { parts: readonly ShapePart[]; color: string }) {
  return (
    <>
      {parts.map((p, i) => {
        if (p.kind === "circle") {
          return p.fill ? (
            <Circle key={i} cx={p.cx} cy={p.cy} r={p.r} fill={color} />
          ) : (
            <Circle key={i} cx={p.cx} cy={p.cy} r={p.r} fill="none" stroke={color} strokeWidth={p.strokeWidth} />
          );
        }
        if (p.kind === "rect") return <Rect key={i} x={p.x} y={p.y} width={p.width} height={p.height} rx={p.rx} fill={color} />;
        return p.fill ? (
          <Path key={i} d={p.d} fill={color} />
        ) : (
          <Path
            key={i}
            d={p.d}
            fill="none"
            stroke={color}
            strokeWidth={p.strokeWidth}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        );
      })}
    </>
  );
}

function Shape({ status, size, color }: { status: ProjectStatus; size: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 10 10">
      <ShapeParts parts={StatusShapes.parts(status)} color={color} />
    </Svg>
  );
}

export function Pill({ pill, x, y }: { pill: PillBox; x: number; y: number }) {
  const c = C.STATUS[pill.status];
  return (
    <View
      style={{
        position: "absolute",
        left: x,
        top: y,
        width: pill.width,
        height: G.PILL_H,
        borderRadius: G.PILL_H / 2,
        backgroundColor: c.bg,
        flexDirection: "row",
        alignItems: "center",
        paddingLeft: G.PILL_PAD,
      }}
    >
      <Shape status={pill.status} size={G.ICON} color={c.fg} />
      <Text style={{ marginLeft: G.ICON_GAP, fontFamily: F, fontSize: G.SIZE.pill, fontWeight: 500, color: c.fg, lineHeight: 1 }}>
        {pill.label}
      </Text>
    </View>
  );
}

function ClockIcon({ color }: { color: string }) {
  return (
    <Svg width={G.DIAMOND} height={G.DIAMOND} viewBox="0 0 10 10" style={{ marginRight: 2.5 }}>
      <Circle cx={5} cy={5} r={4} fill="none" stroke={color} strokeWidth={1.3} />
      <Path d="M5 2.6V5l1.7 1.2" fill="none" stroke={color} strokeWidth={1.3} />
    </Svg>
  );
}

function Flag({ flag, x, y }: { flag: FlagBox; x: number; y: number }) {
  const dashed = flag.kind === "changed" || flag.kind === "stale";
  const changed = flag.kind === "changed";
  const c = flag.kind === "changed" ? C.CHANGED : flag.kind === "stale" ? C.STALE : C.OVERDUE;
  return (
    <View
      style={{
        position: "absolute",
        left: x,
        top: y,
        width: flag.width,
        height: G.PILL_H,
        borderRadius: 2,
        backgroundColor: c.bg,
        flexDirection: "row",
        alignItems: "center",
        paddingLeft: G.FLAG_PAD - (dashed ? 0.75 : 0),
        ...(dashed ? { borderWidth: 0.75, borderStyle: "dashed" as const, borderColor: c.fg } : {}),
      }}
    >
      {flag.kind === "stale" && <ClockIcon color={c.fg} />}
      {changed && (
        <Svg width={G.DIAMOND} height={G.DIAMOND} viewBox="0 0 10 10" style={{ marginRight: 2.5 }}>
          <ShapeParts parts={StatusShapes.DIAMOND} color={c.fg} />
        </Svg>
      )}
      <Text style={{ fontFamily: F, fontSize: G.SIZE.pill, fontWeight: 700, color: c.fg, lineHeight: 1 }}>{flag.label}</Text>
    </View>
  );
}

/** Row flags, each in its fixed slot for the report (ReportLayout.placeFlags): empty slots stay blank. */
function Flags({ flags, x, y }: { flags: PlacedFlag[]; x: number; y: number }) {
  return (
    <>
      {flags.map((f) => (
        <Flag key={f.kind} flag={f} x={x + f.dx} y={y} />
      ))}
    </>
  );
}

function Badge({ text, right, left, top }: { text: string; right?: number; left?: number; top: number }) {
  return (
    <View
      style={{
        position: "absolute",
        ...(left !== undefined ? { left } : { right }),
        top,
        borderWidth: 0.75,
        borderColor: C.DIVIDER,
        borderRadius: 3,
        paddingHorizontal: 5,
        paddingVertical: 1.5,
      }}
    >
      <Text style={{ fontFamily: F, fontSize: G.SIZE.small, fontWeight: 600, color: C.MUTED, letterSpacing: 0.4 }}>{text}</Text>
    </View>
  );
}

function Rule({ y, h, color = C.TEXT, x = 0, w = G.CONTENT_W }: { y: number; h: number; color?: string; x?: number; w?: number }) {
  return <View style={{ position: "absolute", left: x, top: y, width: w, height: h, backgroundColor: color }} />;
}

function FirstHeader({ h }: { h: HeaderModel }) {
  if (h.band) return <BandHeader h={h} />;
  const S = G.SIZE;
  const els: React.ReactNode[] = [];
  const top = h.titleBarHeight + G.HEADER_BODY_PAD;
  const { rows: meta, size: metaSize, keyWidth } = h.meta;
  const valueW = h.metaWidth - keyWidth;
  meta.forEach(([k, v], i) => {
    const ly = top + i * (G.META_ROW_H + G.META_GAP);
    els.push(<Line key={`k${i}`} x={0} y={ly} w={keyWidth} text={k} size={metaSize} color={C.MUTED} lh={G.META_ROW_H} />);
    els.push(<Line key={`v${i}`} x={keyWidth} y={ly} w={valueW} text={v} size={metaSize} weight={500} lh={G.META_ROW_H} />);
    if (h.completedFy && h.completedAt?.row === i) {
      const cx = keyWidth + h.completedAt.x;
      const st = CompletedBlockStyle;
      els.push(<Check key="cc" x={cx} y={ly + (G.META_ROW_H - st.CHECK) / 2} size={st.CHECK} color={st.ACCENT} />);
      els.push(
        <Text
          key="ct"
          style={{ position: "absolute", left: cx + st.CHECK + 3, top: ly, width: 200, fontFamily: F, fontSize: metaSize, lineHeight: G.META_ROW_H / metaSize, color: st.ACCENT, maxLines: 1 }}
        >
          {h.completedFy.label} <Text style={{ fontWeight: 700 }}>{String(h.completedFy.count)}</Text>
        </Text>,
      );
    }
  });
  // Legend
  const ly = top + meta.length * G.META_ROW_H + (meta.length - 1) * G.META_GAP + 6;
  const { changed, overdue, stale } = h.legend;
  els.push(<Line key="lg1" x={0} y={ly + 1} w={30} text="Flags:" size={S.small} weight={600} color={C.MUTED} lh={G.SMALL_LH} />);
  els.push(<Flag key="lgc" flag={changed} x={24} y={ly} />);
  els.push(
    <Line key="lg2" x={24 + changed.width + 4} y={ly + 1} w={h.metaWidth} text={ReportLayout.legendText("changed")} size={S.small} color={C.MUTED} lh={G.SMALL_LH} />,
  );
  els.push(<Flag key="lgo" flag={overdue} x={24} y={ly + G.LEGEND_LINE_H} />);
  els.push(
    <Line
      key="lg3"
      x={24 + overdue.width + 4}
      y={ly + G.LEGEND_LINE_H + 1}
      w={h.metaWidth}
      text={ReportLayout.legendText("overdue")}
      size={S.small}
      color={C.MUTED}
      lh={G.SMALL_LH}
    />,
  );

  els.push(<Flag key="lgs" flag={stale} x={24} y={ly + 2 * G.LEGEND_LINE_H} />);
  els.push(
    <Line
      key="lg4"
      x={24 + stale.width + 4}
      y={ly + 2 * G.LEGEND_LINE_H + 1}
      w={h.metaWidth}
      text={ReportLayout.legendText("stale")}
      size={S.small}
      color={C.MUTED}
      lh={G.SMALL_LH}
    />,
  );

  els.push(<GridView key="grid" h={h} x={G.CONTENT_W - h.grid.width} top={top} />);

  return (
    <>
      <Overline h={h} top={0} />
      <Text
        style={{
          position: "absolute",
          left: 0,
          top: h.titleBarHeight - G.TITLE_BAR_H,
          fontFamily: F,
          fontSize: S.title,
          fontWeight: 700,
          lineHeight: G.TITLE_H / S.title,
          color: C.TEXT,
        }}
      >
        {h.title}
      </Text>
      {h.badge && <Badge text={h.badge} right={0} top={h.overline ? 0 : 2} />}
      <Rule y={h.titleBarHeight - 1.5} h={1.5} />
      {els}
    </>
  );
}

/** Page 1 service line overline (uppercase, secondary). */
function Overline({ h, top }: { h: HeaderModel; top: number }) {
  return (
    <>
      {h.overline?.lines.map((line, i) => (
        <Text
          key={`ol${i}`}
          style={{
            position: "absolute",
            left: 0,
            top: top + i * G.OVERLINE.lineH,
            width: G.CONTENT_W,
            fontFamily: F,
            fontSize: h.overline!.size,
            fontWeight: G.OVERLINE.weight,
            letterSpacing: h.overline!.tracking,
            lineHeight: G.OVERLINE.lineH / h.overline!.size,
            color: C.MUTED,
            maxLines: 1,
          }}
        >
          {line}
        </Text>
      ))}
    </>
  );
}

/**
 * One-band page 1 header (Totals grid Hidden or Last page): overline and title on the left, details
 * right-aligned on the right, a 0.5 pt light-border rule, and in Hidden mode the one-line key under it.
 */
function BandHeader({ h }: { h: HeaderModel }) {
  const S = G.SIZE;
  const band = h.band!;
  const B = G.BAND;
  const st = CompletedBlockStyle;
  return (
    <>
      <Overline h={h} top={0} />
      <Text style={{ position: "absolute", left: 0, top: band.titleY, fontFamily: F, fontSize: S.title, fontWeight: 700, lineHeight: G.TITLE_H / S.title, color: C.TEXT }}>
        {h.title}
      </Text>
      {h.badge && band.badgeX !== null && (
        <Badge text={h.badge} left={band.badgeX} top={band.titleY + 3} />
      )}
      {band.details.map((d, i) => (
        <Fragment key={`bd${i}`}>
          <Text
            style={{
              position: "absolute",
              left: d.x,
              top: band.labelY,
              width: d.w,
              fontFamily: F,
              fontSize: B.labelSize,
              fontWeight: B.labelWeight,
              letterSpacing: B.labelTracking,
              lineHeight: B.labelLH / B.labelSize,
              color: C.MUTED,
              textAlign: "right",
              maxLines: 1,
            }}
          >
            {d.label}
          </Text>
          {d.accent && (
            <Check
              x={d.checkX}
              y={band.valueY + (B.valueLH - st.CHECK) / 2}
              size={st.CHECK}
              color={st.ACCENT}
            />
          )}
          <Text
            style={{
              position: "absolute",
              left: d.x - 12,
              top: band.valueY,
              width: d.w + 12,
              fontFamily: F,
              fontSize: band.valueSize,
              fontWeight: d.accent ? 700 : B.valueWeight,
              lineHeight: B.valueLH / band.valueSize,
              color: d.accent ? st.ACCENT : C.TEXT,
              textAlign: "right",
              maxLines: 1,
            }}
          >
            {d.value}
          </Text>
        </Fragment>
      ))}
      <Rule y={band.height} h={B.ruleW} color={C.DIVIDER} />
      {h.totalsGrid === "hidden" && h.keyLine && <KeyLine k={h.keyLine} y={band.height + B.ruleW + G.KEYLINE.gapAbove} />}
    </>
  );
}

/** Status and flag key: status shapes with labels, then flag chips with their explanations (7 pt, secondary). Wraps only once explanations are cut. */
function KeyLine({ k, y: top }: { k: KeyLineModel; y: number }) {
  const K = G.KEYLINE;
  return (
    <>
      {k.items.map((it, i) => {
        const y = top + it.row * (K.h + K.rowGap);
        return it.kind === "status" ? (
          <Fragment key={`ks${i}`}>
            <View style={{ position: "absolute", left: it.x, top: y + (K.h - K.icon) / 2 }}>
              <Shape status={it.status} size={K.icon} color={C.STATUS[it.status].fg} />
            </View>
            {it.label && <Line x={it.textX} y={y + (K.h - G.SMALL_LH) / 2} w={it.w - (it.textX - it.x)} text={it.label} size={K.size} color={C.MUTED} lh={G.SMALL_LH} />}
          </Fragment>
        ) : (
          <Fragment key={`kf${i}`}>
            <Flag flag={it.flag} x={it.x} y={y} />
            {it.text && <Line x={it.textX} y={y + (K.h - G.SMALL_LH) / 2} w={it.w - (it.textX - it.x)} text={it.text} size={K.size} color={C.MUTED} lh={G.SMALL_LH} />}
          </Fragment>
        );
      })}
    </>
  );
}

/** Status count grid (visible rows only) at `x`, `top`. */
function GridView({ h, x: gx, top }: { h: HeaderModel; x: number; top: number }) {
  const S = G.SIZE;
  const els: React.ReactNode[] = [];
  els.push(<Line key="gh" x={gx} y={top + 3} w={G.GRID_AREA_W} text="Area" size={S.small} weight={500} lh={G.SMALL_LH} />);
  let cx = gx + G.GRID_AREA_W;
  const colX: number[] = [];
  for (const col of h.grid.columns) {
    colX.push(cx);
    if (col.pill) els.push(<Pill key={`gp${col.key}`} pill={col.pill} x={cx + (col.width - col.pill.width) / 2} y={top} />);
    else els.push(<Line key={`gl${col.key}`} x={cx} y={top + 2} w={col.width} text={col.label ?? ""} size={S.small} weight={500} lh={G.SMALL_LH} align="center" />);
    cx += col.width;
  }
  h.grid.rows.forEach((r, ri) => {
    const ry = top + G.GRID_HEAD_H + ri * G.GRID_ROW_H;
    if (r.total) els.push(<Rule key={`gtr`} x={gx} y={ry} w={h.grid.width} h={1} />);
    const weight = r.total ? 600 : 400;
    els.push(<Line key={`ga${ri}`} x={gx} y={ry + 1.5} w={G.GRID_AREA_W} text={r.label} size={S.table} weight={r.total ? 600 : 500} color={r.muted ? C.MUTED : C.TEXT} lh={G.TABLE_LH} />);
    r.cells.forEach((n, ci) => {
      const isTotal = ci === r.cells.length - 1;
      els.push(
        <Line
          key={`gc${ri}-${ci}`}
          x={colX[ci]}
          y={ry + 1.5}
          w={h.grid.columns[ci].width}
          text={n === 0 ? "\u00b7" : String(n)}
          size={S.table}
          weight={isTotal || r.total ? 600 : weight}
          color={n === 0 || r.muted ? C.MUTED : C.TEXT}
          lh={G.TABLE_LH}
          align="center"
        />,
      );
    });
    if (!r.total) els.push(<Rule key={`gb${ri}`} x={gx} y={ry + G.GRID_ROW_H - 0.5} w={h.grid.width} h={0.5} color={C.DIVIDER} />);
  });
  return <>{els}</>;
}

function ContinuationHeader({ h }: { h: HeaderModel }) {
  const S = G.SIZE;
  const els: React.ReactNode[] = [];
  const y = G.RUNHEAD_H + G.STRIP_PAD;
  const run = ReportLayout.runningHeaderText(h);
  h.strip.forEach((line, li) => {
    let x = 0;
    const ly = y + li * G.STRIP_LINE_H;
    for (const it of line) {
      els.push(<Line key={`s${li}${it.area}`} x={x} y={ly} w={60} text={it.label} size={S.small} weight={600} color={it.area === ServiceAreaInfo.UNASSIGNED ? C.MUTED : C.TEXT} lh={G.SMALL_LH} />);
      for (const c of it.counts) {
        const col = C.STATUS[c.status].fg;
        els.push(
          <View key={`si${li}${it.area}${c.status}`} style={{ position: "absolute", left: x + c.iconX, top: ly + 0.75 }}>
            <Shape status={c.status} size={G.ICON} color={col} />
          </View>,
        );
        els.push(
          <Line key={`sn${li}${it.area}${c.status}`} x={x + c.numX} y={ly} w={14} text={String(c.count)} size={S.small} weight={500} lh={G.SMALL_LH} />,
        );
      }
      x += it.width;
    }
  });
  return (
    <>
      <Text style={{ position: "absolute", left: 0, top: 0, fontFamily: F, fontSize: S.body, lineHeight: 12 / S.body, color: C.TEXT }}>
        <Text style={{ fontWeight: 600 }}>{run.lead}</Text>
        {run.rest}
      </Text>
      {h.badge && <Badge text={h.badge} right={0} top={0} />}
      <Rule y={G.RUNHEAD_H - 1.5} h={1.5} />
      {els}
    </>
  );
}

function ColumnHead({ h, y }: { h: HeaderModel; y: number }) {
  const S = G.SIZE;
  return (
    <>
      {h.columns.map((c) => (
        <View key={c.key}>
          <Line x={c.x} y={y + 4} w={c.w - G.CELL_PAD_R} text={c.label} size={S.small} weight={600} color={C.MUTED} lh={G.SMALL_LH} />
          {c.sub && <Line x={c.x} y={y + 4 + G.SMALL_LH} w={c.w - G.CELL_PAD_R} text={c.sub} size={S.small} color={C.MUTED} lh={G.SMALL_LH} />}
        </View>
      ))}
      <Rule y={y + G.COLHEAD_H - 1} h={1} />
    </>
  );
}

function Cell({ cell, row }: { cell: RowCell; row: RowLayout }) {
  const S = G.SIZE;
  const two = row.lineTwoY;
  switch (cell.kind) {
    case "project":
      return (
        <>
          {cell.lines.map((l, i) => (
            <Line key={i} x={cell.x} y={i * G.TABLE_LH} w={cell.w} text={l} size={S.table} weight={600} lh={G.TABLE_LH} />
          ))}
          {cell.meta.map((run, ri) => (
            <MetaText key={`m${ri}`} run={run} x={cell.x} y={cell.lines.length * G.TABLE_LH} w={cell.w} />
          ))}
        </>
      );
    case "owner":
      return (
        <>
          <OwnerText name={cell.owner} more={cell.ownerMore} missing={cell.ownerMissing} labelW={cell.ownerLabelW} x={cell.x} y={0} w={cell.w} />
          {cell.champion && <RequesterText name={cell.champion} more={cell.championMore} labelW={cell.championLabelW} x={cell.x} y={two} w={cell.w} />}
          {cell.contracts && <ContractsText c={cell.contracts} x={cell.x} y={two + (cell.champion ? (1 + cell.championMore.length) * G.SMALL_LH : 0)} w={cell.w} />}
        </>
      );
    case "status":
      return (
        <>
          <Pill pill={cell.pill} x={cell.x} y={-0.25} />
          {cell.change?.lines.map((text, i) => (
            <Line
              key={i}
              x={cell.x + 1}
              y={two + i * G.SMALL_LH}
              w={cell.w + G.CELL_PAD_R}
              text={text}
              size={S.small}
              color={cell.change!.arrow === "down" ? C.WORSE : cell.change!.arrow === "up" ? C.BETTER : C.MUTED}
              lh={G.SMALL_LH}
            />
          ))}
        </>
      );
    case "nextMilestone":
      return (
        <>
          {cell.lines.map((l, i) => (
            <Line key={i} x={cell.x} y={i * G.TABLE_LH} w={cell.w} text={l} size={S.table} weight={G.MILESTONE_WEIGHT} color={cell.done ? C.STATUS.Complete.fg : cell.muted ? C.MUTED : C.TEXT} lh={G.TABLE_LH} />
          ))}
          {cell.progress && (
            <Line
              key="progress"
              x={cell.x + cell.progress.x}
              y={cell.progress.line * G.TABLE_LH + 0.5}
              w={cell.w - cell.progress.x}
              text={cell.progress.text}
              size={S.small}
              color={C.MUTED}
              lh={G.TABLE_LH}
            />
          )}
        </>
      );
    case "due":
      return (
        <Line
          x={cell.x}
          y={0}
          w={cell.w}
          text={cell.text}
          size={S.table}
          weight={cell.overdue ? 600 : 400}
          color={cell.overdue ? C.OVERDUE.bg : cell.muted ? C.MUTED : C.TEXT}
          lh={G.TABLE_LH}
        />
      );
    case "flags":
      return <Flags flags={cell.flags} x={cell.x} y={-0.25} />;
  }
}

function Row({ row, y }: { row: RowLayout; y: number }) {
  const S = G.SIZE;
  const top = y + G.ROW_PAD;
  return (
    <View style={{ position: "absolute", left: 0, top, width: G.CONTENT_W, height: row.height - G.ROW_PAD }}>
      {row.cells.map((c) => (
        <Cell key={c.kind} cell={c} row={row} />
      ))}
      {row.note &&
        row.note.lines.map((l, i) => (
          <Text
            key={`n${i}`}
            style={{
              position: "absolute",
              left: row.note!.x,
              top: row.note!.y + i * G.TABLE_LH,
              width: row.note!.w + 12,
              fontFamily: F,
              fontSize: S.table,
              lineHeight: G.TABLE_LH / S.table,
              // Milestone emphasis: the note is always regular in the secondary color ("No change." included).
              fontWeight: 400,
              color: C.MUTED,
              maxLines: 1,
            }}
          >
            {l.text}
          </Text>
        ))}
      <Rule y={row.height - G.ROW_PAD - G.ROW_BORDER} h={G.ROW_BORDER} color={C.DIVIDER} />
    </View>
  );
}

/** "Contracts Shea Waldron": prefix at weight 500, name regular, both in the requester's small gray. */
/** "Owner: Name": label regular and name 600, both primary; "To assign" regular in the secondary gray. */
function OwnerText({ name, more, missing, labelW, x, y, w }: { name: string; more: readonly string[]; missing: boolean; labelW: number; x: number; y: number; w: number }) {
  const S = G.SIZE;
  const weight = missing ? 400 : ReportLayout.OWNER_NAME_WEIGHT;
  const color = missing ? C.MUTED : C.TEXT;
  return (
    <>
      <Line x={x} y={y} w={labelW + 1} text={PeopleLabel.OWNER} size={S.table} color={C.TEXT} lh={G.TABLE_LH} />
      <Line
        x={x + labelW}
        y={y}
        w={w - labelW}
        text={name}
        size={S.table}
        weight={missing ? 400 : ReportLayout.OWNER_NAME_WEIGHT}
        color={missing ? C.MUTED : C.TEXT}
        lh={G.TABLE_LH}
      />
      {more.map((t, i) => (
        <Line key={i} x={x} y={y + (i + 1) * G.TABLE_LH} w={w} text={t} size={S.table} weight={weight} color={color} lh={G.TABLE_LH} />
      ))}
    </>
  );
}

/** "Requester: Name": label and name regular in the secondary gray. */
function RequesterText({ name, more, labelW, x, y, w }: { name: string; more: readonly string[]; labelW: number; x: number; y: number; w: number }) {
  const S = G.SIZE;
  return (
    <>
      <Line x={x} y={y} w={labelW + 1} text={PeopleLabel.REQUESTER} size={S.small} color={C.MUTED} lh={G.SMALL_LH} />
      <Line x={x + labelW} y={y} w={w - labelW} text={name} size={S.small} color={C.MUTED} lh={G.SMALL_LH} />
      {more.map((t, i) => (
        <Line key={i} x={x} y={y + (i + 1) * G.SMALL_LH} w={w} text={t} size={S.small} color={C.MUTED} lh={G.SMALL_LH} />
      ))}
    </>
  );
}

function ContractsText({ c, x, y, w }: { c: ContractsLine; x: number; y: number; w: number }) {
  const S = G.SIZE;
  return (
    <>
      {c.lines.map((l, i) => {
        const ly = y + i * G.SMALL_LH;
        const tx = l.prefix ? x + c.prefixW : x;
        return (
          <Fragment key={i}>
            {l.prefix && (
              <Line x={x} y={ly} w={c.prefixW + 1} text={l.prefix.trimEnd()} size={S.small} weight={ReportLayout.CONTRACTS_PREFIX_WEIGHT} color={C.MUTED} lh={G.SMALL_LH} />
            )}
            <Line x={tx} y={ly} w={w - (tx - x)} text={l.text} size={S.small} color={C.MUTED} lh={G.SMALL_LH} />
          </Fragment>
        );
      })}
    </>
  );
}

/** Check shape (the Complete status shape) at 10-unit viewBox scale. */
export function Check({ x, y, size, color }: { x: number; y: number; size: number; color: string }) {
  return (
    <View style={{ position: "absolute", left: x, top: y, width: size, height: size }}>
      <Shape status="Complete" size={size} color={color} />
    </View>
  );
}

/** "Completed this period" block: tinted container, header line, then one row per completed project. */
function CompletedBlock({ block, top }: { block: Extract<BodyBlock, { kind: "completed" }>; top: number }) {
  const S = G.SIZE;
  const st = CompletedBlockStyle;
  const y0 = top + block.y + st.SPACE_ABOVE;
  const h = block.height - st.SPACE_ABOVE;
  return (
    <View wrap={false} style={{ position: "absolute", left: 0, top: y0, width: G.CONTENT_W, height: h }}>
      <View
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: G.CONTENT_W,
          height: h,
          backgroundColor: st.FILL,
          borderWidth: st.BORDER_W,
          borderColor: st.BORDER,
          borderLeftWidth: st.EDGE_W,
          borderLeftColor: st.ACCENT,
          borderRadius: st.RADIUS,
        }}
      />
      <Check x={st.INSET} y={(st.HEADER_H - st.CHECK) / 2} size={st.CHECK} color={st.ACCENT} />
      <Line
        x={st.INSET + st.CHECK + 3}
        y={(st.HEADER_H - G.SMALL_LH) / 2}
        w={200}
        text={st.HEADING}
        size={st.HEADING_SIZE}
        weight={600}
        color={st.ACCENT}
        lh={G.SMALL_LH}
      />
      <Line x={G.CONTENT_W - 306} y={(st.HEADER_H - G.SMALL_LH) / 2} w={300} text={st.NOTE} size={st.HEADING_SIZE} color={st.ACCENT} lh={G.SMALL_LH} align="right" />
      {block.rows.map((r) => {
        const ry = r.y - st.SPACE_ABOVE;
        const inner = ry + G.ROW_PAD;
        return (
          <View key={r.projectId} style={{ position: "absolute", left: 0, top: 0, width: G.CONTENT_W, height: h }}>
            <Rule y={ry} h={st.SEPARATOR_W} color={st.SEPARATOR} x={st.EDGE_W} w={G.CONTENT_W - st.EDGE_W - st.BORDER_W} />
            {r.name.lines.map((l, i) => (
              <Line key={`n${i}`} x={r.name.x} y={inner + i * G.TABLE_LH} w={r.name.w} text={l} size={S.table} weight={600} lh={G.TABLE_LH} />
            ))}
            {r.req && <MetaText run={r.req} x={r.name.x} y={inner + r.name.lines.length * G.TABLE_LH} w={r.name.w} />}
            {r.owner && (
              <>
                <OwnerText name={r.owner.owner} more={r.owner.ownerMore} missing={r.owner.ownerMissing} labelW={r.owner.ownerLabelW} x={r.owner.x} y={inner} w={r.owner.w} />
                {r.owner.champion && (
                  <RequesterText
                    name={r.owner.champion}
                    more={r.owner.championMore}
                    labelW={r.owner.championLabelW}
                    x={r.owner.x}
                    y={inner + (1 + r.owner.ownerMore.length) * G.TABLE_LH + G.LINE_GAP}
                    w={r.owner.w}
                  />
                )}
                {r.owner.contracts && (
                  <ContractsText
                    c={r.owner.contracts}
                    x={r.owner.x}
                    y={inner + (1 + r.owner.ownerMore.length) * G.TABLE_LH + G.LINE_GAP + (r.owner.champion ? (1 + r.owner.championMore.length) * G.SMALL_LH : 0)}
                    w={r.owner.w}
                  />
                )}
              </>
            )}
            {r.date && (
              <>
                <Check x={r.date.x} y={inner + (G.TABLE_LH - st.CHECK) / 2} size={st.CHECK} color={st.ACCENT} />
                <Line x={r.date.x + st.CHECK + 3} y={inner} w={r.date.w - st.CHECK - 3} text={r.date.text} size={S.table} weight={500} color={st.ACCENT} lh={G.TABLE_LH} />
              </>
            )}
            {r.accomplishment?.lines.map((l, i) => (
              <Line key={`a${i}`} x={r.accomplishment!.x} y={inner + i * G.TABLE_LH} w={r.accomplishment!.w} text={l} size={S.table} lh={G.TABLE_LH} />
            ))}
          </View>
        );
      })}
    </View>
  );
}

/** Last page mode: "SUMMARY" overline, the grid, then the one-line key, as one unsplittable block. */
function SummaryBlock({ h, block, top }: { h: HeaderModel; block: Extract<BodyBlock, { kind: "summary" }>; top: number }) {
  const s = block.summary;
  const y0 = top + block.y;
  return (
    <View wrap={false} style={{ position: "absolute", left: 0, top: y0, width: G.CONTENT_W, height: block.height }}>
      <Text
        style={{
          position: "absolute",
          left: 0,
          top: s.gapAbove,
          fontFamily: F,
          fontSize: G.OVERLINE.size,
          fontWeight: G.OVERLINE.weight,
          letterSpacing: G.OVERLINE.tracking,
          lineHeight: G.SUMMARY.overlineLH / G.OVERLINE.size,
          color: C.MUTED,
        }}
      >
        {G.SUMMARY.label}
      </Text>
      <GridView h={h} x={0} top={s.gridTop} />
      {h.keyLine && <KeyLine k={h.keyLine} y={s.keyTop} />}
    </View>
  );
}

function Block({ block, top, h }: { block: BodyBlock; top: number; h: HeaderModel }) {
  const S = G.SIZE;
  if (block.kind === "summary") return <SummaryBlock h={h} block={block} top={top} />;
  if (block.kind === "row") return <Row row={block.row} y={top + block.y} />;
  if (block.kind === "completed") return <CompletedBlock block={block} top={top} />;
  if (block.kind === "empty") return <Line x={0} y={top + block.y + 6} w={G.CONTENT_W} text={block.text} size={S.body} color={C.MUTED} lh={12} />;
  const sy = top + block.y + block.height - G.SECTION_H;
  const count = ReportLayout.sectionCountText(block.count, block.completedCount);
  // Unassigned: same section head, name and left border in the secondary gray (no amber, no italics).
  const ink = block.area === ServiceAreaInfo.UNASSIGNED ? C.MUTED : C.TEXT;
  return (
    <View style={{ position: "absolute", left: 0, top: sy, width: G.CONTENT_W, height: G.SECTION_H, backgroundColor: C.SECTION_BG_STRONG }}>
      <View style={{ position: "absolute", left: 0, top: 0, width: 2, height: G.SECTION_H, backgroundColor: ink }} />
      <Line x={7} y={2} w={300} text={`${block.label}${block.continued ? " (continued)" : ""}`} size={S.section} weight={600} color={ink} lh={12} />
      <Line x={G.CONTENT_W - 205} y={4} w={200} text={count} size={S.small} color={C.MUTED} lh={G.SMALL_LH} align="right" />
    </View>
  );
}

function KeyPage({ k, top }: { k: KeyModel; top: number }) {
  const S = G.SIZE;
  const els: React.ReactNode[] = [];
  let y = top + 14;
  els.push(<Line key="t" x={0} y={y} w={400} text={k.title} size={S.section + 2} weight={600} lh={14} />);
  y += 24;
  const section = (label: string) => {
    els.push(<Line key={`h${label}`} x={0} y={y} w={300} text={label} size={S.small} weight={600} color={C.MUTED} lh={G.SMALL_LH} />);
    els.push(<Rule key={`r${label}`} y={y + 11} h={0.5} color={C.DIVIDER} w={420} />);
    y += 16;
  };
  section("STATUS");
  for (const s of k.statuses) {
    els.push(<Pill key={`p${s.pill.status}`} pill={s.pill} x={0} y={y} />);
    els.push(<Line key={`m${s.pill.status}`} x={90} y={y} w={330} text={s.meaning} size={S.table} lh={G.TABLE_LH + 0.5} />);
    y += 16;
  }
  y += 8;
  section("FLAGS");
  for (const f of k.flags) {
    els.push(<Flag key={`f${f.flag.kind}`} flag={f.flag} x={0} y={y} />);
    els.push(<Line key={`fm${f.flag.kind}`} x={90} y={y} w={330} text={f.meaning} size={S.table} lh={G.TABLE_LH + 0.5} />);
    y += 16;
  }
  y += 8;
  section("ROW DETAILS");
  for (const d of k.details) {
    const color = d.sample.startsWith("\u2193")
      ? C.WORSE
      : d.sample === "Due in red"
        ? C.OVERDUE.bg
        : d.sample === "Updated Sep 1"
          ? C.STALE.fg
          : C.MUTED;
    els.push(<Line key={`d${d.sample}`} x={0} y={y} w={88} text={d.sample} size={S.small} weight={d.sample === "Due in red" ? 600 : 400} color={color} lh={G.TABLE_LH} />);
    els.push(<Line key={`dm${d.sample}`} x={90} y={y} w={330} text={d.meaning} size={S.table} lh={G.TABLE_LH} />);
    y += 15;
  }
  y += 10;
  els.push(<Line key="fn" x={0} y={y} w={G.CONTENT_W} text={k.footnote} size={S.small} color={C.MUTED} lh={G.SMALL_LH} />);
  return <>{els}</>;
}

function PageView({ layout, page }: { layout: DocumentLayout; page: PageLayout }) {
  const h = layout.header;
  const footY = G.CONTENT_H - G.FOOTER_H;
  return (
    <Page size={{ width: G.PAGE_W, height: G.PAGE_H }} style={{ backgroundColor: C.BG }}>
      <View style={{ position: "absolute", left: G.MARGIN, top: G.MARGIN, width: G.CONTENT_W, height: G.CONTENT_H }}>
        {page.first ? <FirstHeader h={h} /> : <ContinuationHeader h={h} />}
        {page.kind === "key" && layout.key ? (
          <KeyPage k={layout.key} top={page.bodyTop} />
        ) : (
          <>
            {page.columnHead !== false && <ColumnHead h={h} y={page.headerHeight} />}
            {page.blocks.map((b, i) => (
              <Block key={i} block={b} top={page.bodyTop} h={h} />
            ))}
          </>
        )}
        <Rule y={footY} h={0.5} color={C.DIVIDER} />
        <Line x={0} y={footY + 4} w={G.CONTENT_W - 80} text={h.footerLeft} size={G.SIZE.small} color={C.MUTED} lh={G.SMALL_LH} />
        <Line
          x={G.CONTENT_W - 80}
          y={footY + 4}
          w={80}
          text={`Page ${page.number} of ${page.total}`}
          size={G.SIZE.small}
          color={C.MUTED}
          lh={G.SMALL_LH}
          align="right"
        />
      </View>
    </Page>
  );
}

/** The report PDF, drawn from a precomputed DocumentLayout (no layout decisions happen here). */
export function ReportDocument({ layout, title }: { layout: DocumentLayout; title: string }) {
  return (
    <Document title={title} author="Cardiac Procedure Services" creator="Cardiac portfolio tracker" producer="Cardiac portfolio tracker">
      {layout.pages.map((p) => (
        <PageView key={p.number} layout={layout} page={p} />
      ))}
    </Document>
  );
}
