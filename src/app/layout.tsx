import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Service Line Portfolio",
  description: "Cardiac service line project portfolio (internal)",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="dark h-full">
      <body className="min-h-full bg-bg text-fg">{children}</body>
    </html>
  );
}
