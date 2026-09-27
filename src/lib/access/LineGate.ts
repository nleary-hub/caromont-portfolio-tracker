import type { Viewer } from "@/lib/auth/AdminPolicy";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { Db } from "@/lib/db/Db";
import { ServiceLine, type ServiceLineScope } from "@/lib/domain/ServiceLine";
import { LineAccessService } from "@/lib/services/LineAccessService";

type Reader = Parameters<typeof ServiceLineAccess.activeFor>[1];

/** What a line page (dashboard, report archive) renders for this viewer and request. */
export type LineGateResult =
  /** The page for this line; `lines` feeds the switcher. */
  | { kind: "ok"; scope: ServiceLineScope; lines: ServiceLineScope[] }
  /** No line at all: the "You don't have access yet" card only. */
  | { kind: "none" }
  /** A ?line= link to a line they can't use (or that doesn't exist; the card is the same): name it, offer their first line. */
  | { kind: "lacks"; requested: string; first: Pick<ServiceLineScope, "shortName"> }
  /** A ?line= link to one of their lines: it is saved as their line; reload without the parameter. */
  | { kind: "switched"; to: string };

/**
 * Server-side gate for pages a non-admin can open. Every other entry point (routes, actions, exports) asks
 * ServiceLineAccess directly and answers 404 / an error. Links name a line by short code: `/?line=EP`.
 */
export class LineGate {
  /** "ep " -> "EP"; anything that can't be a short name -> null (the parameter is ignored). */
  static requestedCode(raw: string | string[] | undefined): string | null {
    const v = (Array.isArray(raw) ? raw[0] : raw)?.trim().toUpperCase() ?? "";
    return /^[A-Z0-9]{2,12}$/.test(v) ? v : null;
  }

  /** The switcher link for a line: the page with ?line=<short code>. */
  static href(path: string, shortName: string): string {
    return `${path}?line=${encodeURIComponent(shortName)}`;
  }

  static async forPage(viewer: Viewer & { name?: string | null }, rawLine: string | string[] | undefined, path: string, db?: Reader): Promise<LineGateResult> {
    if (!db && !Db.isConfigured()) {
      // Local pages without a database: admins get the default line as before; nobody else gets any line.
      return viewer.isAdmin ? { kind: "ok", scope: ServiceLine.defaultScope(), lines: [] } : { kind: "none" };
    }
    const client = db ?? Db.client;
    if (!db) await LineAccessService.touchQuietly(viewer);
    const lines = await ServiceLineAccess.usableLines(viewer, client);
    if (!lines.length && !viewer.isAdmin) return { kind: "none" };
    const code = LineGate.requestedCode(rawLine);
    if (code) {
      const match = lines.find((l) => l.shortName.toUpperCase() === code);
      if (!match) {
        const first = lines[0] ?? (await ServiceLineAccess.defaultLine(client));
        return { kind: "lacks", requested: code, first: { shortName: first.shortName } };
      }
      await ServiceLineAccess.setActive(viewer, match.id, client as never);
      return { kind: "switched", to: path };
    }
    return { kind: "ok", scope: await ServiceLineAccess.activeFor(viewer, client), lines };
  }
}
