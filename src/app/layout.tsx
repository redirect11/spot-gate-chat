import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "67th — mIRC-style chat",
  description: "Real-time mIRC-style chat, powered by Firebase",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  themeColor: "#010409",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="it" className="h-full">
      <body className="h-full">
        {/* TEMP diagnostic: surface uncaught JS errors on devices without
            dev tools (e.g. iOS Safari). Remove once the hydration issue is
            understood. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){function show(m){var d=document.getElementById('__err')||document.createElement('div');d.id='__err';d.style.cssText='position:fixed;left:0;right:0;bottom:0;z-index:99999;background:#f85149;color:#000;font:12px monospace;padding:8px;white-space:pre-wrap;max-height:60%;overflow:auto';d.textContent='ERR: '+m;document.body.appendChild(d);}window.addEventListener('error',function(e){show((e.message||(e.error&&e.error.message)||'error')+' @ '+(e.filename||'')+':'+(e.lineno||'')+':'+(e.colno||''));});window.addEventListener('unhandledrejection',function(e){var r=e.reason;show('promise: '+((r&&(r.message||r.code||r))||'rejection'));});})();`,
          }}
        />
        {children}
      </body>
    </html>
  );
}
