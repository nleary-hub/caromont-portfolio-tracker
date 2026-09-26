// Next.js 16 renamed middleware.ts → proxy.ts. Protects every route except sign-in and Auth.js endpoints.
// Unauthenticated (or no-longer-allowlisted) requests are redirected to /signin by the `authorized` callback.
export { auth as proxy } from "@/auth";

export const config = {
  matcher: ["/((?!api/auth|signin|_next/static|_next/image|favicon.ico|robots.txt).*)"],
};
