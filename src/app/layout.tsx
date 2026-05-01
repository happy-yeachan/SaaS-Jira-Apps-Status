import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { TooltipProvider } from "@/components/ui/tooltip";
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
  title: "Atlassian App Status — Real-time Jira & Confluence App Health",
  description:
    "Monitor the live service health of your Atlassian Marketplace apps — ScriptRunner, Tempo, draw.io, Zephyr and hundreds more. One dashboard, no login required.",
  keywords: [
    "Jira",
    "Confluence",
    "Atlassian",
    "app status",
    "service health",
    "monitoring",
    "marketplace",
    "ScriptRunner",
    "Tempo",
    "Zephyr",
  ],
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
  openGraph: {
    title: "Atlassian App Status",
    description:
      "Real-time service health for Jira & Confluence marketplace apps. One dashboard for all your installed apps.",
    type: "website",
    locale: "en_US",
  },
  twitter: {
    card: "summary",
    title: "Atlassian App Status",
    description: "Real-time service health for Jira & Confluence marketplace apps.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <head>
        {/* Prevent dark-mode flash — runs before React hydration */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem('theme');var p=window.matchMedia('(prefers-color-scheme:dark)').matches;if(t==='dark'||(t===null&&p))document.documentElement.classList.add('dark');}catch(e){}`,
          }}
        />
      </head>
      <body className="min-h-full flex flex-col">
        <TooltipProvider>{children}</TooltipProvider>
      </body>
    </html>
  );
}
