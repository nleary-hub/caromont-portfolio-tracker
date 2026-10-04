import { timingSafeEqual } from "node:crypto";
import type { ReportArtifact } from "@/generated/prisma/client";
import { ReportEnv, type EnvSource } from "@/lib/config/ReportEnv";
import { StoredPdfCopy } from "@/lib/report/StoredPdf";

/** HTTP helpers shared by the report routes. */
export class ReportHttp {
  /** Authorization: Bearer <CRON_SECRET>, constant-time. Fails closed when CRON_SECRET is unset. */
  static cronAuthorized(authorization: string | null, env: EnvSource = process.env): boolean {
    const secret = ReportEnv.cronSecret(env);
    if (!secret || !authorization) return false;
    const expected = Buffer.from(`Bearer ${secret}`);
    const given = Buffer.from(authorization);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  static notFound(): Response {
    return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  }

  /**
   * A frozen report whose stored PDF is gone: a small error page with the freeze day (never rebuilt from the snapshot,
   * and no Rebuild button). Dark surface and tokens as the app.
   */
  static storedPdfMissing(generatedAt: Date): Response {
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(StoredPdfCopy.TITLE)}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0F1115;color:#E6E8EC;font:14px/1.5 Inter,system-ui,sans-serif}
main{max-width:440px;margin:24px;padding:20px 22px;background:#171A21;border:1px solid #262A33;border-radius:10px;display:flex;gap:12px}
svg{flex:none;margin-top:2px}h1{margin:0 0 6px;font-size:16px;font-weight:600}p{margin:0;color:#9AA1AD}</style></head>
<body><main data-testid="stored-pdf-missing"><svg role="img" aria-label="${esc(StoredPdfCopy.ICON_LABEL)}" width="20" height="20" viewBox="0 0 20 20"><circle cx="10" cy="10" r="9" fill="none" stroke="#FF7A7F" stroke-width="1.6"/><path d="M10 5.5v5.5" stroke="#FF7A7F" stroke-width="1.8" stroke-linecap="round"/><circle cx="10" cy="14.2" r="1.1" fill="#FF7A7F"/></svg>
<div><h1>${esc(StoredPdfCopy.TITLE)}</h1><p>${esc(StoredPdfCopy.message(StoredPdfCopy.frozenOn(generatedAt)))}</p></div></main></body></html>`;
    return new Response(html, { status: 404, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
  }

  static file(bytes: Uint8Array, contentType: string, fileName: string, disposition: "attachment" | "inline" = "attachment"): Response {
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(bytes.byteLength),
        "Content-Disposition": `${disposition}; filename="${fileName.replace(/[^\w.-]/g, "_")}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  static artifact(a: ReportArtifact, disposition: "attachment" | "inline" = "attachment"): Response {
    return ReportHttp.file(a.bytes, a.contentType, a.fileName, disposition);
  }
}
