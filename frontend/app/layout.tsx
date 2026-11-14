import type { Metadata } from "next";
import "@fontsource/londrina-solid/400.css";
import "@fontsource-variable/libre-franklin";
import "./globals.css";
import "./palette.css";
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
