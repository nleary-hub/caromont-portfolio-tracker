import { ServiceLineCopy } from "@/lib/domain/ServiceLine";

export interface ServiceLineColumn {
  key: "name" | "shortName" | "projects" | "updated" | "actions";
  /** Header text; the actions column has a screen-reader label only. */
  label: string;
  /** Fixed width in px; null takes the remaining width (the name). */
  width: number | null;
  align: "left" | "right";
}

/**
 * The one column definition for both service line tables (active and archived) on /admin/service-lines. Both
 * render a colgroup from it with table-layout: fixed, so Short name, Projects and Updated line up.
 */
export class ServiceLineTable {
  static readonly COLUMNS: readonly ServiceLineColumn[] = [
    { key: "name", label: ServiceLineCopy.COLUMNS[0], width: null, align: "left" },
    { key: "shortName", label: ServiceLineCopy.COLUMNS[1], width: 160, align: "left" },
    { key: "projects", label: ServiceLineCopy.COLUMNS[2], width: 112, align: "right" },
    { key: "updated", label: ServiceLineCopy.COLUMNS[3], width: 160, align: "left" },
    { key: "actions", label: "Actions", width: 56, align: "right" },
  ];

  static widthStyle(column: ServiceLineColumn): { width?: string } {
    return column.width === null ? {} : { width: `${column.width}px` };
  }
}
