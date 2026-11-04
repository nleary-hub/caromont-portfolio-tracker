import type { NextRequest } from "next/server";
import { OwnerGate } from "@/lib/auth/OwnerGate";
import { Db } from "@/lib/db/Db";
import type { DriveConnectionDb } from "@/lib/report/DriveConnection";
import { DriveOAuth } from "@/lib/report/DriveOAuth";
import { DriveOAuthHttp } from "@/lib/report/DriveOAuthHttp";
import { ReportHttp } from "@/lib/report/ReportHttp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Google sends the Owner back here after Reconnect Drive. Owner only, checked on the server (anyone else: the generic
 * 404, and nothing is exchanged or saved). DriveOAuth.finish checks the state against the cookie, swaps the code with
 * the PKCE verifier and saves the refresh token encrypted. The cookie is always cleared. Ends on /reports?drive=<code>.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const viewer = await OwnerGate.ownerViewer();
  if (!viewer) return DriveOAuthHttp.clearStateCookie(ReportHttp.notFound());
  const outcome = await DriveOAuth.finish({
    query: request.nextUrl.searchParams,
    cookie: request.cookies.get(DriveOAuth.COOKIE)?.value,
    connectedBy: viewer.email,
    // Read only when there is a token to save, so a refused callback never opens a database connection.
    get db() {
      return Db.client as unknown as DriveConnectionDb;
    },
  });
  const res = DriveOAuthHttp.back(request, outcome);
  DriveOAuthHttp.clearStateCookie(res);
  return res;
}
