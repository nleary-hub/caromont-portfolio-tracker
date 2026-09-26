import type { ProjectStatus } from "@/generated/prisma/enums";
import { StatusShapes, type ShapePart } from "@/lib/domain/StatusShapes";

function Part({ part }: { part: ShapePart }) {
  switch (part.kind) {
    case "circle":
      return part.fill ? (
        <circle cx={part.cx} cy={part.cy} r={part.r} fill="currentColor" />
      ) : (
        <circle cx={part.cx} cy={part.cy} r={part.r} fill="none" stroke="currentColor" strokeWidth={part.strokeWidth} />
      );
    case "rect":
      return <rect x={part.x} y={part.y} width={part.width} height={part.height} rx={part.rx} fill="currentColor" />;
    case "path":
      return part.fill ? (
        <path d={part.d} fill="currentColor" />
      ) : (
        <path
          d={part.d}
          fill="none"
          stroke="currentColor"
          strokeWidth={part.strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      );
  }
}

/** 10px status icon in the current text color (the pill's foreground). */
export function StatusShape({ status }: { status: ProjectStatus }) {
  const v = StatusShapes.VIEWBOX;
  return (
    <svg width="10" height="10" viewBox={`0 0 ${v} ${v}`} aria-hidden="true" className="st-shape">
      {StatusShapes.parts(status).map((p, i) => (
        <Part key={i} part={p} />
      ))}
    </svg>
  );
}
