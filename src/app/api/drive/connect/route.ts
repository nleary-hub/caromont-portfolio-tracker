import { NextResponse, type NextRequest } from "next/server";
import { OwnerGate } from "@/lib/auth/OwnerGate";
import { DriveOAuth } from "@/lib/report/DriveOAuth";
import { DriveOAuthHttp } from "@/lib/report/DriveOAuthHttp";
import { ReportHttp } from "@/lib/report/ReportHttp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Report freeze > Reconnect Drive (a form POST). Owner only, checked here on the server; everyone else gets the generic
 * 404. A cross-site POST is refused too (Origin must be this site). Sets the state and PKCE cookie and sends the Owner
 * to Google's consent page, or back to /reports with the reason it can't start.
 */
export async function POST(request: NextRequest): Promise<Response> {
  const viewer = await OwnerGate.ownerViewer();
  if (!viewer) return ReportHttp.notFound();
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== request.nextUrl.origin) return ReportHttp.notFound();
  const started = DriveOAuth.start(process.env, request.nextUrl.origin);
  if (!started.ok) return DriveOAuthHttp.back(request, started.problem);
  const res = NextResponse.redirect(started.url, 303);
  res.headers.set("Cache-Control", "no-store");
  DriveOAuthHttp.setStateCookie(res, request, started.cookie);
  return res;
}
