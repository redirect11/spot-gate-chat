import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "67th — mIRC-style chat",
  description: "Real-time mIRC-style chat, powered by Firebase",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="it" className="h-full">
      <body className="h-full">{children}</body>
    </html>
  );
}
