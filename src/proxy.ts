// Next.js 16 renamed middleware.ts → proxy.ts. Protects every route except sign-in and Auth.js endpoints.
// Unauthenticated (or no-longer-allowlisted) requests are redirected to /signin by the `authorized` callback.
// Not covered: /api/cron/* (CRON_SECRET bearer check in the route) and /api/share/* (HMAC-signed,
// expiring report links verified in the route).
export { auth as proxy } from "@/auth";

export const config = {
  matcher: ["/((?!api/auth|api/cron/|api/share/|signin|_next/static|_next/image|favicon.ico|robots.txt).*)"],
};
