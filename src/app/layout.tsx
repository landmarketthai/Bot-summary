import type { Metadata } from "next";
import "@fontsource/sarabun/300.css";
import "@fontsource/sarabun/400.css";
import "@fontsource/sarabun/500.css";
import "@fontsource/sarabun/600.css";
import "@fontsource/sarabun/700.css";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "LINE Dashboard",
    template: "%s | LINE Dashboard",
  },
  description: "Automated LINE message parsing and analytics dashboard",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="th" className="h-full">
      <body className="h-full antialiased">{children}</body>
    </html>
  );
}
