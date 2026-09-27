import { Document, Page, Text, View } from "@react-pdf/renderer";
import { Fragment } from "react";
import { Check, Pill, ReportColors as C } from "@/lib/report/pdf/ReportDocument";
import { ReportFonts } from "@/lib/report/pdf/ReportFonts";
import { CompletedBlockStyle, ReportGeometry as G } from "@/lib/report/pdf/ReportLayout";
import { YearEndLayout, type YearEndBlock, type YearEndDocumentLayout, type YearEndPage } from "@/lib/report/pdf/YearEndLayout";
import { YearEndCopy } from "@/lib/report/YearEndReportData";

const F = ReportFonts.FAMILY;

function Line({ x, y, w, text, size, weight = 400, color = C.TEXT, lh, align = "left" }: { x: number; y: number; w: number; text: string; size: number; weight?: number; color?: string; lh: number; align?: "left" | "right" | "center" }) {
  return (
    <Text
      style={{ position: "absolute", left: align === "right" ? x - 12 : x, top: y, width: w + 12, fontFamily: F, fontSize: size, fontWeight: weight, lineHeight: lh / size, color, textAlign: align, maxLines: 1 }}
    >
      {text}
    </Text>
  );
}

function Rule({ y, h, color = C.TEXT, x = 0, w = G.CONTENT_W }: { y: number; h: number; color?: string; x?: number; w?: number }) {
  return <View style={{ position: "absolute", left: x, top: y, width: w, height: h, backgroundColor: color }} />;
}

/** Page 1: overline, title and the right-aligned details, as the weekly one-band header. */
function FirstHeader({ l }: { l: YearEndDocumentLayout }) {
  const B = G.BAND;
  const band = l.band;
  return (
    <>
      {l.overline?.lines.map((line, i) => (
        <Text
          key={`ol${i}`}
          style={{ position: "absolute", left: 0, top: i * G.OVERLINE.lineH, width: G.CONTENT_W, fontFamily: F, fontSize: l.overline!.size, fontWeight: G.OVERLINE.weight, letterSpacing: l.overline!.tracking, lineHeight: G.OVERLINE.lineH / l.overline!.size, color: C.MUTED, maxLines: 1 }}
        >
          {line}
        </Text>
      ))}
      <Text style={{ position: "absolute", left: 0, top: band.titleY, fontFamily: F, fontSize: G.SIZE.title, fontWeight: 700, lineHeight: G.TITLE_H / G.SIZE.title, color: C.TEXT }}>{l.title}</Text>
      {band.details.map((d, i) => (
        <Fragment key={`bd${i}`}>
          <Text
            style={{ position: "absolute", left: d.x, top: band.labelY, width: d.w, fontFamily: F, fontSize: B.labelSize, fontWeight: B.labelWeight, letterSpacing: B.labelTracking, lineHeight: B.labelLH / B.labelSize, color: C.MUTED, textAlign: "right", maxLines: 1 }}
          >
            {d.label}
          </Text>
          {d.accent && <Check x={d.checkX} y={band.valueY + (B.valueLH - CompletedBlockStyle.CHECK) / 2} size={CompletedBlockStyle.CHECK} color={CompletedBlockStyle.ACCENT} />}
          <Text
            style={{ position: "absolute", left: d.x - 12, top: band.valueY, width: d.w + 12, fontFamily: F, fontSize: band.valueSize, fontWeight: B.valueWeight, lineHeight: B.valueLH / band.valueSize, color: C.TEXT, textAlign: "right", maxLines: 1 }}
          >
            {d.value}
          </Text>
        </Fragment>
      ))}
      <Rule y={band.height} h={B.ruleW} color={C.DIVIDER} />
    </>
  );
}

function ContinuationHeader({ l }: { l: YearEndDocumentLayout }) {
  return (
    <>
      <Text style={{ position: "absolute", left: 0, top: 0, fontFamily: F, fontSize: G.SIZE.body, lineHeight: 12 / G.SIZE.body, color: C.TEXT }}>
        <Text style={{ fontWeight: 600 }}>{l.runningLead}</Text>
        {l.runningRest}
      </Text>
      <Rule y={G.RUNHEAD_H - 1.5} h={1.5} />
    </>
  );
}

function Summary({ l, top }: { l: YearEndDocumentLayout; top: number }) {
  const S = YearEndLayout.GRID;
  const els: React.ReactNode[] = [];
  const width = S.labelW + 3 * S.colW;
  els.push(
    <Text key="lbl" style={{ position: "absolute", left: 0, top, fontFamily: F, fontSize: G.OVERLINE.size, fontWeight: G.OVERLINE.weight, letterSpacing: G.OVERLINE.tracking, lineHeight: G.SUMMARY.overlineLH / G.OVERLINE.size, color: C.MUTED }}>
      {YearEndCopy.SUMMARY}
    </Text>,
  );
  const gt = top + YearEndLayout.SUMMARY_LABEL_H;
  const heads = l.summaryHeads;
  els.push(<Line key="gh" x={0} y={gt + 2} w={S.labelW} text={YearEndCopy.DEPARTMENT} size={G.SIZE.small} weight={500} lh={G.SMALL_LH} />);
  heads.forEach((h, i) => els.push(<Line key={`gh${i}`} x={S.labelW + i * S.colW} y={gt + 2} w={S.colW} text={h} size={G.SIZE.small} weight={500} lh={G.SMALL_LH} align="right" />));
  l.summary.forEach((r, ri) => {
    const ry = gt + S.headH + ri * S.rowH;
    const total = r.area === "total";
    if (total) els.push(<Rule key="tr" x={0} y={ry} w={width} h={1} />);
    els.push(<Line key={`ga${ri}`} x={0} y={ry + 1.5} w={S.labelW} text={r.label} size={G.SIZE.table} weight={total ? 600 : 500} color={r.muted ? C.MUTED : C.TEXT} lh={G.TABLE_LH} />);
    [r.completed, r.cancelled, r.carried].forEach((n, ci) =>
      els.push(
        <Line key={`gc${ri}-${ci}`} x={S.labelW + ci * S.colW} y={ry + 1.5} w={S.colW} text={n === 0 ? "\u00b7" : String(n)} size={G.SIZE.table} weight={total ? 600 : 400} color={n === 0 || r.muted ? C.MUTED : C.TEXT} lh={G.TABLE_LH} align="right" />,
      ),
    );
    if (!total) els.push(<Rule key={`gb${ri}`} x={0} y={ry + S.rowH - 0.5} w={width} h={0.5} color={C.DIVIDER} />);
  });
  return <>{els}</>;
}

function Block({ b, top, l }: { b: YearEndBlock; top: number; l: YearEndDocumentLayout }) {
  const y = top + b.y;
  const S = G.SIZE;
  const Col = YearEndLayout.COLUMNS;
  switch (b.kind) {
    case "summary":
      return <Summary l={l} top={y} />;
    case "heading":
      return <Line x={0} y={y + b.height - YearEndLayout.HEADING.h} w={G.CONTENT_W} text={b.text} size={YearEndLayout.HEADING.size} weight={600} lh={YearEndLayout.HEADING.h} />;
    case "colhead": {
      const labels = YearEndLayout.columnLabels(b.section);
      const cols = [Col.project, Col.owner, Col.requester, Col.date, Col.update];
      return (
        <>
          {cols.map((c, i) => (
            <Line key={i} x={c.x} y={y + 5} w={c.w - G.CELL_PAD_R} text={labels[i].toUpperCase()} size={S.small} weight={600} color={C.MUTED} lh={G.SMALL_LH} />
          ))}
          <Rule y={y + b.height - 1} h={1} />
        </>
      );
    }
    case "dept": {
      const sy = y + b.height - G.SECTION_H;
      const ink = b.muted ? C.MUTED : C.TEXT;
      return (
        <View style={{ position: "absolute", left: 0, top: sy, width: G.CONTENT_W, height: G.SECTION_H, backgroundColor: C.SECTION_BG_STRONG }}>
          <View style={{ position: "absolute", left: 0, top: 0, width: 2, height: G.SECTION_H, backgroundColor: ink }} />
          <Line x={7} y={2} w={300} text={`${b.label}${b.continued ? " (continued)" : ""}`} size={S.section} weight={600} color={ink} lh={12} />
          <Line x={G.CONTENT_W - 205} y={4} w={200} text={b.count} size={S.small} color={C.MUTED} lh={G.SMALL_LH} align="right" />
        </View>
      );
    }
    case "row": {
      const r = b.row;
      const ty = y + G.ROW_PAD;
      const w = (c: { w: number }) => c.w - G.CELL_PAD_R;
      return (
        <>
          {r.name.map((t, i) => (
            <Line key={`n${i}`} x={Col.project.x} y={ty + i * G.TABLE_LH} w={w(Col.project)} text={t} size={S.table} weight={600} lh={G.TABLE_LH} />
          ))}
          <Line x={Col.owner.x} y={ty} w={w(Col.owner)} text={r.owner.text} size={S.table} color={r.owner.muted ? C.MUTED : C.TEXT} lh={G.TABLE_LH} />
          {r.requester && <Line x={Col.requester.x} y={ty} w={w(Col.requester)} text={r.requester.text} size={S.table} color={r.requester.muted ? C.MUTED : C.TEXT} lh={G.TABLE_LH} />}
          {r.date && <Line x={Col.date.x} y={ty} w={w(Col.date)} text={r.date} size={S.table} lh={G.TABLE_LH} />}
          {r.pill && <Pill pill={r.pill} x={Col.date.x} y={ty - 0.25} />}
          {r.update.map((t, i) => (
            <Line key={`u${i}`} x={Col.update.x} y={ty + i * G.TABLE_LH} w={w(Col.update)} text={t} size={S.table} color={C.MUTED} lh={G.TABLE_LH} />
          ))}
          <Rule y={y + b.height - G.ROW_BORDER} h={G.ROW_BORDER} color={C.DIVIDER} />
        </>
      );
    }
    case "empty":
      return <Line x={0} y={y + 5} w={G.CONTENT_W} text={b.text} size={S.body} color={C.MUTED} lh={12} />;
  }
}

function PageView({ l, page }: { l: YearEndDocumentLayout; page: YearEndPage }) {
  const footY = G.CONTENT_H - G.FOOTER_H;
  return (
    <Page size={{ width: G.PAGE_W, height: G.PAGE_H }} style={{ backgroundColor: C.BG }}>
      <View style={{ position: "absolute", left: G.MARGIN, top: G.MARGIN, width: G.CONTENT_W, height: G.CONTENT_H }}>
        {page.first ? <FirstHeader l={l} /> : <ContinuationHeader l={l} />}
        {page.blocks.map((b, i) => (
          <Block key={i} b={b} top={page.bodyTop} l={l} />
        ))}
        <Rule y={footY} h={0.5} color={C.DIVIDER} />
        <Line x={0} y={footY + 4} w={G.CONTENT_W - 80} text={l.footerLeft} size={G.SIZE.small} color={C.MUTED} lh={G.SMALL_LH} />
        <Line x={G.CONTENT_W - 80} y={footY + 4} w={80} text={`Page ${page.number} of ${page.total}`} size={G.SIZE.small} color={C.MUTED} lh={G.SMALL_LH} align="right" />
      </View>
    </Page>
  );
}

/** The year-end report PDF, drawn from a precomputed YearEndLayout. */
export function YearEndDocument({ layout, serviceLineName }: { layout: YearEndDocumentLayout; serviceLineName: string | null }) {
  const title = serviceLineName ? `${serviceLineName}: ${layout.title}` : layout.title;
  return (
    <Document title={title} author="Cardiac Procedure Services" creator="Cardiac portfolio tracker" producer="Cardiac portfolio tracker">
      {layout.pages.map((p) => (
        <PageView key={p.number} l={layout} page={p} />
      ))}
    </Document>
  );
}
