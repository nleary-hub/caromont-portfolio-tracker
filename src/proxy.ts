// Next.js 16 renamed middleware.ts → proxy.ts. Protects every route except sign-in and Auth.js endpoints.
// Unauthenticated (or no-longer-allowlisted) requests are redirected to /signin by the `authorized` callback.
// Service line access (item 8) is checked on the server in each page, route and action (ServiceLineAccess, LineGate),
// not here. Not covered: /api/cron/* (CRON_SECRET bearer check in the route) and /api/share/* (HMAC-signed,
// expiring report links verified in the route). /fonts/ is the public Inter font: /signin needs it before sign-in. Logo files directly under /brand/
// (svg, png, ico) whose filename matches [\w-][\w.-]* and the exact /manifest.webmanifest are public; a leading dot stays
// behind sign-in, and nothing else under /brand is.
// Claude connector: /api/mcp (connector bearer token checked in the route), /oauth/register and /oauth/token (OAuth
// endpoints that never read the session) and /.well-known/ metadata are public; /oauth/authorize (the consent page)
// stays behind sign-in, so only a signed-in person can approve a connection, for themself.
// /about, /privacy and /terms (exact paths, PublicPages) are public: Google's OAuth branding needs them signed out.
export { auth as proxy } from "@/auth";

export const config = {
  matcher: ["/((?!api/auth|api/cron/|api/share/|api/mcp|oauth/register|oauth/token|\\.well-known/|signin|about$|privacy$|terms$|fonts/|brand/[\\w-][\\w.-]*\\.(?:svg|png|ico)$|manifest\\.webmanifest$|_next/static|_next/image|favicon.ico|robots.txt).*)"],
};
