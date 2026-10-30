import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Suspense } from "react";
import { AppShell } from "../components/app-shell";
import { RenewalReminderBanner } from "../components/renewal-reminder-banner";
import { PILOT_RENEWAL_FACTS, bannerFacts } from "../lib/renewal/renewal-facts";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Benefits Navigator",
  description:
    "A guided companion for benefits applications. We help you prepare; you decide what gets submitted.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <AppShell>
          {/* BN-22: the on-device renewal reminder, on any page the person returns to.
              Suspense, because it reads the pathname: without a boundary, the
              first dynamic route would fail the build (Cache Components). */}
          <Suspense fallback={null}>
            <RenewalReminderBanner facts={bannerFacts(PILOT_RENEWAL_FACTS)} />
          </Suspense>
          {children}
        </AppShell>
      </body>
    </html>
  );
}
