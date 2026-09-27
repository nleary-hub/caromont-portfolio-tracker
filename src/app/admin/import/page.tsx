import type { Metadata } from "next";
import { AdminMenuSlot } from "@/components/AdminMenuSlot";
import { ImportPanel } from "@/components/ImportPanel";
import { AdminGate } from "@/lib/auth/AdminGate";
import { AdminPolicy } from "@/lib/auth/AdminPolicy";
import { AppConfig } from "@/lib/config/AppConfig";
import { ProjectCsv } from "@/lib/import/ProjectCsv";
import { ServiceLineAccess } from "@/lib/access/ServiceLineAccess";
import { ServiceLineSlot } from "@/components/ServiceLineSlot";

export const metadata: Metadata = { title: "Import projects" };

export default async function AdminImportPage() {
  // Enforced here (not only in the proxy): non-admins get a 404.
  const adminEmail = await AdminGate.requireAdmin();
  const viewer = AdminPolicy.viewerFor(adminEmail);
  // Import and export work on the admin's active service line.
  const scope = await ServiceLineAccess.activeOrDefault(viewer);
  return (
    <ImportPanel
      adminEmail={adminEmail}
      serviceLine={scope}
      switcher={<ServiceLineSlot viewer={viewer} active={scope} />}
      adminMenu={<AdminMenuSlot viewer={viewer} />}
      templateColumns={[...ProjectCsv.TEMPLATE_COLUMNS]}
      limits={{
        rows: AppConfig.IMPORT_MAX_ROWS,
        note: AppConfig.NOTE_MAX_LENGTH,
        milestone: AppConfig.MILESTONE_MAX_LENGTH,
      }}
    />
  );
}
