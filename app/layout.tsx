import type { Metadata } from "next";
import { Geist } from "next/font/google";
import { ThemeProvider } from "next-themes";
import "./globals.css";

const defaultUrl = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(defaultUrl),
  title: "Tapswipe CRM",
  description: "Internal CRM for Tapswipe merchant services.",
};

const geistSans = Geist({
  variable: "--font-geist-sans",
  display: "swap",
  subsets: ["latin"],
});

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      {/* `variable` + `font-sans` rather than `geistSans.className`, so the
          font has one source of truth: the fontFamily token in
          tailwind.config.ts. */}
      <body className={`${geistSans.variable} font-sans antialiased`}>
        {/* Pinned to light: the design is a light theme with a permanently dark
            sidebar, and there is no dark palette yet. See app/globals.css. */}
        <ThemeProvider
          attribute="class"
          defaultTheme="light"
          enableSystem={false}
          disableTransitionOnChange
        >
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
