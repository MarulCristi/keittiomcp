import type { Metadata } from "next";
import "@fontsource-variable/dm-sans";
import "./globals.css";
import "./brand.css";

export const metadata: Metadata = {
  title: "KeittiöMCP | Purchasing control centre",
  description: "Monitor purchase orders, review approvals and manage purchasing policies.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
