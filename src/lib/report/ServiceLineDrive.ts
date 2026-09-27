import type { ServiceLineScope } from "@/lib/domain/ServiceLine";

export class ServiceLineDriveError extends Error {
  constructor(shortName: string) {
    super(`Drive delivery is for the default service line only (not ${shortName})`);
    this.name = "ServiceLineDriveError";
  }
}

/**
 * Where a service line's reports may go in Google Drive (Frank's rule). The Wednesday email picks up the newest
 * report in the configured Drive folder, so that folder holds the default line's (CVPSL) scheduled reports and
 * nothing else. Any Drive save for another line, now or later, goes to that line's own subfolder
 * (`subfolderName`). Today only the default line is delivered to Drive at all; other lines have on-demand PDFs.
 */
export class ServiceLineDrive {
  /** Parent of per-line subfolders, inside the configured folder. */
  static readonly LINES_FOLDER = "Service lines";

  /** Whether files for this line may be uploaded to the configured folder itself. */
  static usesRootFolder(line: Pick<ServiceLineScope, "isDefault">): boolean {
    return line.isDefault;
  }

  /** Subfolder path for a non-default line: ["Service lines", "<SHORT>"]. Null for the default line (root). */
  static subfolderPath(line: Pick<ServiceLineScope, "isDefault" | "shortName">): string[] | null {
    return line.isDefault ? null : [ServiceLineDrive.LINES_FOLDER, line.shortName];
  }

  /** Guard before any upload to the configured folder. */
  static assertRootAllowed(line: Pick<ServiceLineScope, "isDefault" | "shortName">): void {
    if (!ServiceLineDrive.usesRootFolder(line)) throw new ServiceLineDriveError(line.shortName);
  }
}
