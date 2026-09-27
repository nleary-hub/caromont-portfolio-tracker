import { ClosedPageRoute } from "@/components/ClosedPageRoute";
import { ClosedPageModel } from "@/lib/closed/ClosedPageModel";

export const dynamic = "force-dynamic";

export default async function CancelledPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return ClosedPageRoute.render(ClosedPageModel.CANCELLED, searchParams);
}
