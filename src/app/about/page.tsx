import type { Metadata } from "next";
import { PublicDocPage } from "@/components/PublicDocPage";
import { PublicPages } from "@/lib/legal/PublicPages";

// Public: proxy.ts leaves /about outside sign-in (Google's OAuth branding needs it reachable signed out).
export const metadata: Metadata = { title: "About · Service Line Portfolio Tracker" };

export default function Page() {
  return <PublicDocPage page={PublicPages.ABOUT} />;
}
