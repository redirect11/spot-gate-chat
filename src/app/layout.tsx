import type { Metadata, Viewport } from "next";
import Script from "next/script";
import "./globals.css";

export const metadata: Metadata = {
  title: "67t — mIRC-style chat",
  description: "Real-time mIRC-style chat, powered by Firebase",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#010409",
};

// Array/String.prototype.at polyfill for Safari < 15.4 / older Chrome. It's a
// runtime API (not syntax), so the browserslist transpilation doesn't cover it.
// Loaded beforeInteractive via next/script so it runs before the app bundle
// without interfering with React hydration.
const AT_POLYFILL = `(function(){function at(n){n=Math.trunc(n)||0;if(n<0)n+=this.length;if(n<0||n>=this.length)return undefined;return this[n];}if(!Array.prototype.at){Object.defineProperty(Array.prototype,'at',{value:at,writable:true,configurable:true});}if(!String.prototype.at){Object.defineProperty(String.prototype,'at',{value:at,writable:true,configurable:true});}})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="it" className="h-full">
      <body className="h-full">
        <Script id="at-polyfill" strategy="beforeInteractive">
          {AT_POLYFILL}
        </Script>
        {children}
      </body>
    </html>
  );
}
