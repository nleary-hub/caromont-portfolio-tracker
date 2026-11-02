import type { Metadata, Viewport } from "next";
import "./globals.css";
import { AiRefreshListener } from "@/components/AiRefreshListener";
import { ClientErrorReporter } from "@/components/ClientErrorReporter";

export const metadata: Metadata = {
  title: "Service Line Portfolio",
  description: "Cardiac service line project portfolio (internal)",
  robots: { index: false, follow: false },
  // Today Line logo. The browser tab uses the simplified favicon, never the full icon scaled down.
  icons: {
    icon: [
      { url: "/brand/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon.ico", sizes: "any" },
    ],
    apple: [
      { url: "/brand/apple-touch-icon-180.png", sizes: "180x180" },
      { url: "/brand/app-icon-167.png", sizes: "167x167" },
      { url: "/brand/app-icon-152.png", sizes: "152x152" },
    ],
  },
};

export const viewport: Viewport = { themeColor: "#0F1115" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="dark h-full">
      <body className="min-h-full bg-bg text-fg">
        <ClientErrorReporter />
        <AiRefreshListener />
        {children}
      </body>
    </html>
  );
}
