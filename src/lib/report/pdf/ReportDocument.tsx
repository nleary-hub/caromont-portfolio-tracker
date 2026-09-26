import { Circle, Document, Page, Path, Rect, Svg, Text, View } from "@react-pdf/renderer";
import type { ProjectStatus } from "@/generated/prisma/enums";
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
  type KeyModel,
  CompletedBlockStyle,
  type MetaRun,
  type PageLayout,
  type PillBox,
  type RowCell,
  type RowLayout,
} from "@/lib/report/pdf/ReportLayout";

/** Light print palette (src/styles/tokens.css, *-light-*). */
export class ReportColors {
  static readonly TEXT = "#15171C";
  static readonly MUTED = "#5B6270";
  static readonly DIVIDER = "#D9DCE1";
  static readonly SECTION_BG = "#F4F5F7";
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

function Pill({ pill, x, y }: { pill: PillBox; x: number; y: number }) {
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

function Flags({ flags, x, y }: { flags: FlagBox[]; x: number; y: number }) {
  const offsets = flags.map((_, i) => flags.slice(0, i).reduce((sum, f) => sum + f.width + G.FLAG_GAP, 0));
  return (
    <>
      {flags.map((f, i) => (
        <Flag key={f.kind} flag={f} x={x + offsets[i]} y={y} />
      ))}
    </>
  );
}

function Badge({ text, right, top }: { text: string; right: number; top: number }) {
  return (
    <View
      style={{
        position: "absolute",
        right,
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

function FirstHeader({ h, draft }: { h: HeaderModel; draft: boolean }) {
  const S = G.SIZE;
  let y = G.TITLE_BAR_H;
  const els: React.ReactNode[] = [];
  if (draft && h.draftLine) {
    els.push(<Line key="draft" x={0} y={y + 2} w={G.CONTENT_W} text={h.draftLine} size={S.small} color={C.MUTED} lh={G.SMALL_LH} />);
    y += G.DRAFT_LINE_H;
  }
  const top = y + G.HEADER_BODY_PAD;
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
  const changed: FlagBox = h.grid.columns.find((c) => c.key === "changed")!.flag!;
  const overdue: FlagBox = h.grid.columns.find((c) => c.key === "overdue")!.flag!;
  const stale: FlagBox = h.grid.columns.find((c) => c.key === "stale")!.flag!;
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

  // Status count grid (visible rows only)
  const gx = G.CONTENT_W - h.grid.width;
  els.push(<Line key="gh" x={gx} y={top + 3} w={G.GRID_AREA_W} text="Area" size={S.small} weight={500} lh={G.SMALL_LH} />);
  let cx = gx + G.GRID_AREA_W;
  const colX: number[] = [];
  for (const col of h.grid.columns) {
    colX.push(cx);
    if (col.pill) els.push(<Pill key={`gp${col.key}`} pill={col.pill} x={cx + (col.width - col.pill.width) / 2} y={top} />);
    else if (col.flag) els.push(<Flag key={`gf${col.key}`} flag={col.flag} x={cx + (col.width - col.flag.width) / 2} y={top} />);
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

  return (
    <>
      <Text style={{ position: "absolute", left: 0, top: 0, fontFamily: F, fontSize: S.title, fontWeight: 700, lineHeight: G.TITLE_H / S.title, color: C.TEXT }}>
        {h.title}
      </Text>
      {h.badge && <Badge text={h.badge} right={0} top={2} />}
      <Rule y={G.TITLE_BAR_H - 1.5} h={1.5} />
      {els}
    </>
  );
}

function ContinuationHeader({ h, draft }: { h: HeaderModel; draft: boolean }) {
  const S = G.SIZE;
  let y = G.RUNHEAD_H;
  const els: React.ReactNode[] = [];
  if (draft && h.draftLine) {
    els.push(<Line key="draft" x={0} y={y + 2} w={G.CONTENT_W} text={h.draftLine} size={S.small} color={C.MUTED} lh={G.SMALL_LH} />);
    y += G.DRAFT_LINE_H;
  }
  y += G.STRIP_PAD;
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
        <Text style={{ fontWeight: 600 }}>{h.title}</Text>
        {` \u00b7 Report of ${h.reportDateMedium}${h.period ? ` \u00b7 Period ${h.period}` : ""} (continued)`}
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
          <Line x={cell.x} y={0} w={cell.w} text={cell.owner} size={S.table} color={cell.ownerMissing ? C.MUTED : C.TEXT} lh={G.TABLE_LH} />
          {cell.champion && <Line x={cell.x} y={two} w={cell.w} text={cell.champion} size={S.small} color={C.MUTED} lh={G.SMALL_LH} />}
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
            <Line key={i} x={cell.x} y={i * G.TABLE_LH} w={cell.w} text={l} size={S.table} color={cell.muted ? C.MUTED : C.TEXT} lh={G.TABLE_LH} />
          ))}
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
              color: row.note!.muted ? C.MUTED : C.TEXT,
              maxLines: 1,
            }}
          >
            {l.mutedPrefix ? (
              <>
                <Text style={{ color: C.MUTED }}>{l.text.slice(0, l.mutedPrefix)}</Text>
                {l.text.slice(l.mutedPrefix)}
              </>
            ) : (
              l.text
            )}
          </Text>
        ))}
      <Rule y={row.height - G.ROW_PAD - G.ROW_BORDER} h={G.ROW_BORDER} color={C.DIVIDER} />
    </View>
  );
}

/** Check shape (the Complete status shape) at 10-unit viewBox scale. */
function Check({ x, y, size, color }: { x: number; y: number; size: number; color: string }) {
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
                <Line x={r.owner.x} y={inner} w={r.owner.w} text={r.owner.owner} size={S.table} color={r.owner.ownerMissing ? C.MUTED : C.TEXT} lh={G.TABLE_LH} />
                {r.owner.champion && (
                  <Line x={r.owner.x} y={inner + G.TABLE_LH + G.LINE_GAP} w={r.owner.w} text={r.owner.champion} size={S.small} color={C.MUTED} lh={G.SMALL_LH} />
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

function Block({ block, top }: { block: BodyBlock; top: number }) {
  const S = G.SIZE;
  if (block.kind === "row") return <Row row={block.row} y={top + block.y} />;
  if (block.kind === "completed") return <CompletedBlock block={block} top={top} />;
  if (block.kind === "empty") return <Line x={0} y={top + block.y + 6} w={G.CONTENT_W} text={block.text} size={S.body} color={C.MUTED} lh={12} />;
  const sy = top + block.y + block.height - G.SECTION_H;
  const count = ReportLayout.sectionCountText(block.count, block.completedCount);
  // Unassigned: same section head, name and left border in the secondary gray (no amber, no italics).
  const ink = block.area === ServiceAreaInfo.UNASSIGNED ? C.MUTED : C.TEXT;
  return (
    <View style={{ position: "absolute", left: 0, top: sy, width: G.CONTENT_W, height: G.SECTION_H, backgroundColor: C.SECTION_BG }}>
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

function PageView({ layout, page, draft }: { layout: DocumentLayout; page: PageLayout; draft: boolean }) {
  const h = layout.header;
  const footY = G.CONTENT_H - G.FOOTER_H;
  return (
    <Page size={{ width: G.PAGE_W, height: G.PAGE_H }} style={{ backgroundColor: C.BG }}>
      <View style={{ position: "absolute", left: G.MARGIN, top: G.MARGIN, width: G.CONTENT_W, height: G.CONTENT_H }}>
        {page.first ? <FirstHeader h={h} draft={draft} /> : <ContinuationHeader h={h} draft={draft} />}
        {page.kind === "key" && layout.key ? (
          <KeyPage k={layout.key} top={page.bodyTop} />
        ) : (
          <>
            <ColumnHead h={h} y={page.headerHeight} />
            {page.blocks.map((b, i) => (
              <Block key={i} block={b} top={page.bodyTop} />
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
export function ReportDocument({ layout, draft, title }: { layout: DocumentLayout; draft: boolean; title: string }) {
  return (
    <Document title={title} author="Cardiac Procedure Services" creator="Cardiac portfolio tracker" producer="Cardiac portfolio tracker">
      {layout.pages.map((p) => (
        <PageView key={p.number} layout={layout} page={p} draft={draft} />
      ))}
    </Document>
  );
}
