import type { Metadata } from "next";
import { Geist, Geist_Mono, Source_Serif_4 } from "next/font/google";
import { AppShell } from "../components/app-shell";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

// Display face for headings (frontend-polish): loaded through the same
// next/font mechanism as the body faces — no new dependency, no runtime
// fetch by app code.
const serifDisplay = Source_Serif_4({
  variable: "--font-serif-display",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: "Benefits Navigator",
  description:
    "A guided companion for benefits applications. We help you prepare; you decide what gets submitted.",
};

// PR #51 P3: apply stored display settings before first paint, so a
// returning user never flashes the 100% / low-contrast defaults and then
// jumps. Reads the same key/shape as src/lib/display.ts (bn_display_v1:
// { zoomIndex, highContrast }); anything malformed is ignored and the
// component's post-mount load remains the authority.
const DISPLAY_BOOTSTRAP = `(function(){try{var raw=localStorage.getItem("bn_display_v1");if(!raw)return;var s=JSON.parse(raw);var steps=["100%","125%","150%","200%","250%"];var i=typeof s.zoomIndex==="number"?Math.max(0,Math.min(steps.length-1,Math.trunc(s.zoomIndex))):0;var root=document.documentElement;if(i>0){root.setAttribute("data-text-zoom",steps[i]);root.style.fontSize=steps[i];}if(s.highContrast===true){root.setAttribute("data-contrast","high");}}catch(e){}})();`;

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${serifDisplay.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <script dangerouslySetInnerHTML={{ __html: DISPLAY_BOOTSTRAP }} />
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
