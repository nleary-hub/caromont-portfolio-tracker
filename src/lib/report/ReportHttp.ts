import { timingSafeEqual } from "node:crypto";
import type { ReportArtifact } from "@/generated/prisma/client";
import { ReportEnv, type EnvSource } from "@/lib/config/ReportEnv";

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
