import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import ExperienceMotion from "./ExperienceMotion";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ??
    requestHeaders.get("host") ??
    "localhost:3000";
  const protocol =
    requestHeaders.get("x-forwarded-proto") ??
    (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  const socialImage = `${origin}/og.png`;

  return {
    // The default is used as-is (the template only wraps child titles,
    // measured on the local server), so it carries the brand itself; child
    // pages must NOT put the brand in their own titles or the template
    // doubles it — "Docs — BaseCLF | BaseCLF" was live until 2026-08-21.
    title: {
      default: "BaseCLF | The backend layer for Cloudflare",
      template: "%s | BaseCLF",
    },
    description:
      "Auth, database, storage, instant APIs, and real row-level security for Cloudflare D1.",
    openGraph: {
      title: "The backend you know. Built for Cloudflare.",
      description: "Real row-level security for D1.",
      type: "website",
      images: [{ url: socialImage, width: 1732, height: 907 }],
    },
    twitter: {
      card: "summary_large_image",
      title: "The backend you know. Built for Cloudflare.",
      description: "Real row-level security for D1.",
      images: [socialImage],
    },
    icons: {
      icon: [
        { url: "/favicon.ico", sizes: "any" },
        { url: "/favicon-64.png", type: "image/png", sizes: "64x64" },
        { url: "/favicon.svg", type: "image/svg+xml" },
      ],
      shortcut: "/favicon.ico",
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" data-theme="light" style={{ colorScheme: "light" }}>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <ExperienceMotion />
        {children}
      </body>
    </html>
  );
}
