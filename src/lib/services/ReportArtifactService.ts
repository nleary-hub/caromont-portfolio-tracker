import { createHash } from "node:crypto";
import type { PrismaClient, ReportArtifact } from "@/generated/prisma/client";
import { Db } from "@/lib/db/Db";

export type ArtifactKind = "pdf" | "handoff";

/** Stores and reads a snapshot's rendered files in Postgres (report_artifacts, immutable). */
export class ReportArtifactService {
  static readonly STORAGE_PREFIX = "db:report_artifacts/";

  static storageKey(artifactId: string): string {
    return `${ReportArtifactService.STORAGE_PREFIX}${artifactId}`;
  }

  static sha256(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
  }

  static async get(snapshotId: string, kind: ArtifactKind, db: PrismaClient = Db.client): Promise<ReportArtifact | null> {
    return db.reportArtifact.findFirst({ where: { snapshotId, kind } });
  }

  /** Write-once per (snapshot, kind). A concurrent writer that loses the race gets the stored row back. */
  static async store(
    input: { snapshotId: string; kind: ArtifactKind; fileName: string; contentType: string; bytes: Uint8Array },
    db: PrismaClient = Db.client,
  ): Promise<ReportArtifact> {
    try {
      return await db.reportArtifact.create({
        data: {
          snapshotId: input.snapshotId,
          kind: input.kind,
          fileName: input.fileName,
          contentType: input.contentType,
          bytes: new Uint8Array(input.bytes),
          byteSize: input.bytes.byteLength,
          sha256: ReportArtifactService.sha256(input.bytes),
        },
      });
    } catch (e) {
      if ((e as { code?: unknown })?.code === "P2002") {
        const existing = await ReportArtifactService.get(input.snapshotId, input.kind, db);
        if (existing) return existing;
      }
      throw e;
    }
  }
}
