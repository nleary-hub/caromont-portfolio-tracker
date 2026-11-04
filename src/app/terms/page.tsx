import type { Metadata } from "next";
import { PublicDocPage } from "@/components/PublicDocPage";
import { PublicPages } from "@/lib/legal/PublicPages";

// Public: proxy.ts leaves /terms outside sign-in (Google's OAuth branding needs it reachable signed out).
export const metadata: Metadata = { title: "Terms of service · Service Line Portfolio Tracker" };

export default function Page() {
  return <PublicDocPage page={PublicPages.TERMS} />;
}
