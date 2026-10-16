import { ClientErrorRateLimit, ClientErrorScrub } from "@/lib/errors/ClientErrorScrub";

// Browser error reports (ClientErrorReporter, error.tsx, global-error.tsx). Signed-in only (proxy.ts). The body is
// scrubbed again here and only message, stack and route are logged, so it lands in the Vercel runtime logs.
const limit = new ClientErrorRateLimit();
const MAX_BODY = 8_000;

export async function POST(req: Request): Promise<Response> {
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";
  if (!limit.allow(ip)) return new Response(null, { status: 429 });
  const raw = await req.text();
  if (raw.length > MAX_BODY) return new Response(null, { status: 413 });
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response(null, { status: 400 });
  }
  const report = ClientErrorScrub.report(body);
  console.log("client-error", JSON.stringify(report));
  return new Response(null, { status: 204 });
}
