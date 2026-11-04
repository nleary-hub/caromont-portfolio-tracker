import { NextResponse, type NextRequest } from "next/server";
import { DriveOAuth, type DriveConnectOutcome } from "@/lib/report/DriveOAuth";

/** Responses for the Reconnect Drive routes: back to Report freeze with an outcome code, and the state cookie. */
export class DriveOAuthHttp {
  /** 303 to /reports?drive=<code> on the origin the Owner is on, never cached. */
  static back(request: NextRequest, outcome: DriveConnectOutcome): NextResponse {
    const url = new URL(DriveOAuth.RETURN_PATH, request.nextUrl.origin);
    url.searchParams.set("drive", outcome);
    const res = NextResponse.redirect(url, 303);
    res.headers.set("Cache-Control", "no-store");
    return res;
  }

  static setStateCookie(res: NextResponse, request: NextRequest, value: string): void {
    res.cookies.set(DriveOAuth.COOKIE, value, {
      httpOnly: true,
      secure: request.nextUrl.protocol === "https:",
      sameSite: "lax",
      path: DriveOAuth.COOKIE_PATH,
      maxAge: DriveOAuth.COOKIE_MAX_AGE,
    });
  }

  static clearStateCookie(res: Response): Response {
    res.headers.append("Set-Cookie", `${DriveOAuth.COOKIE}=; Path=${DriveOAuth.COOKIE_PATH}; Max-Age=0; HttpOnly; SameSite=Lax`);
    return res;
  }
}
