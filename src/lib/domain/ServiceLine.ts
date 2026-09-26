/** Service line name shown in the top bar and the report header (admin setting, frozen into snapshots). */
export interface ServiceLineValue {
  /** Full name, e.g. "Cardiovascular & Pulmonary Service Line". */
  name: string;
  /** Short name for narrow screens, e.g. "CVPSL". */
  shortName: string;
}

export type ServiceLineField = keyof ServiceLineValue;

export class ServiceLineValidationError extends Error {
  constructor(readonly errors: Partial<Record<ServiceLineField, string>>) {
    super(Object.values(errors).join(" "));
    this.name = "ServiceLineValidationError";
  }
}

/** Pure rules for the service line name. Storage lives in ServiceLineService. */
export class ServiceLine {
  /** Seed values (migration 0014) and the fallback when the settings row is missing. */
  static readonly SEED: Readonly<ServiceLineValue> = { name: "Cardiovascular & Pulmonary Service Line", shortName: "CVPSL" };
  /**
   * The report title's service line before this setting existed. Snapshots frozen before migration 0014
   * have no serviceLineJson and keep rendering with this, so old reports never change.
   */
  static readonly LEGACY_REPORT_NAME = "Cardiac Service Line";
  static readonly NAME_MAX_LENGTH = 80;
  static readonly SHORT_MAX_LENGTH = 12;
  static readonly REPORT_TITLE_SUFFIX = "Project Status Report";

  static defaults(): ServiceLineValue {
    return { ...ServiceLine.SEED };
  }

  /** Collapse runs of whitespace and trim. */
  static clean(value: unknown): string {
    return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  }

  /** Validated, cleaned value; throws ServiceLineValidationError with per-field messages. */
  static parse(raw: { name?: unknown; shortName?: unknown }): ServiceLineValue {
    const name = ServiceLine.clean(raw.name);
    const shortName = ServiceLine.clean(raw.shortName);
    const errors: Partial<Record<ServiceLineField, string>> = {};
    if (!name) errors.name = "Service line name is required.";
    else if (name.length > ServiceLine.NAME_MAX_LENGTH) errors.name = `Service line name must be ${ServiceLine.NAME_MAX_LENGTH} characters or fewer.`;
    if (!shortName) errors.shortName = "Short name is required.";
    else if (shortName.length > ServiceLine.SHORT_MAX_LENGTH) errors.shortName = `Short name must be ${ServiceLine.SHORT_MAX_LENGTH} characters or fewer.`;
    if (Object.keys(errors).length > 0) throw new ServiceLineValidationError(errors);
    return { name, shortName };
  }

  /** Anything (DB row, JSON) to a value; invalid or missing parts fall back to the seed. */
  static normalize(raw: unknown): ServiceLineValue {
    const r = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<ServiceLineField, unknown>>;
    const name = ServiceLine.clean(r.name);
    const shortName = ServiceLine.clean(r.shortName);
    return {
      name: name && name.length <= ServiceLine.NAME_MAX_LENGTH ? name : ServiceLine.SEED.name,
      shortName: shortName && shortName.length <= ServiceLine.SHORT_MAX_LENGTH ? shortName : ServiceLine.SEED.shortName,
    };
  }

  /**
   * The service line a frozen snapshot renders with: its own frozen value, or null for snapshots frozen
   * before migration 0014 (no serviceLineJson, so no short name either). Null renders the legacy header
   * exactly as those reports were drawn: one combined title line with LEGACY_REPORT_NAME.
   */
  static fromSnapshot(serviceLineJson: unknown): ServiceLineValue | null {
    if (serviceLineJson === null || serviceLineJson === undefined) return null;
    return ServiceLine.normalize(serviceLineJson);
  }

  /** Combined one-line title for PDF metadata and handoff.json only (legacy name when null). */
  static metadataTitle(value: Pick<ServiceLineValue, "name"> | null | undefined): string {
    return ServiceLine.reportTitle({ name: value?.name || ServiceLine.LEGACY_REPORT_NAME });
  }

  /** Running header lead on report pages 2 and later: "CVPSL \u00b7 Project Status Report". */
  static runningTitle(value: Pick<ServiceLineValue, "shortName">): string {
    return `${value.shortName} \u00b7 ${ServiceLine.REPORT_TITLE_SUFFIX}`;
  }

  static reportTitle(value: Pick<ServiceLineValue, "name">): string {
    return `${value.name}: ${ServiceLine.REPORT_TITLE_SUFFIX}`;
  }

  static equals(a: ServiceLineValue, b: ServiceLineValue): boolean {
    return a.name === b.name && a.shortName === b.shortName;
  }
}
