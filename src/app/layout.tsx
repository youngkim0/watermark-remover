import type { Metadata } from "next";
import { Instrument_Serif, IBM_Plex_Mono } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";
import { SITE_URL, SITE_NAME, FAQ } from "@/lib/content";

const serif = Instrument_Serif({
  variable: "--font-serif",
  weight: "400",
  style: ["normal", "italic"],
  subsets: ["latin"],
});

const mono = IBM_Plex_Mono({
  variable: "--font-mono",
  weight: ["400", "500"],
  subsets: ["latin"],
});

const DESCRIPTION =
  "Remove watermarks from images free, right in your browser. Unmark erases the AI sparkle from Gemini and Nano Banana, plus logos, text and timestamps — your photos never leave your device.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Unmark — Free AI Watermark Remover, In Your Browser",
    template: "%s · Unmark",
  },
  description: DESCRIPTION,
  applicationName: SITE_NAME,
  keywords: [
    "watermark remover",
    "remove watermark",
    "AI watermark remover",
    "Gemini watermark remover",
    "Nano Banana watermark remover",
    "remove watermark from image",
    "free watermark remover",
    "online watermark remover",
    "remove watermark online",
    "remove logo from photo",
    "image inpainting",
  ],
  authors: [{ name: SITE_NAME }],
  creator: SITE_NAME,
  alternates: { canonical: "/" },
  category: "technology",
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: SITE_NAME,
    title: "Unmark — Free AI Watermark Remover, In Your Browser",
    description: DESCRIPTION,
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "Unmark — Free AI Watermark Remover",
    description: DESCRIPTION,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, "max-image-preview": "large" },
  },
};

const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebApplication",
      name: SITE_NAME,
      url: SITE_URL,
      applicationCategory: "MultimediaApplication",
      operatingSystem: "Web",
      browserRequirements: "Requires a modern browser with WebAssembly",
      description: DESCRIPTION,
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      featureList: [
        "Remove AI watermarks from images",
        "On-device processing — no uploads",
        "Automatic corner watermark removal",
        "Manual brush for logos, text and objects",
      ],
    },
    {
      "@type": "FAQPage",
      mainEntity: FAQ.map((f) => ({
        "@type": "Question",
        name: f.q,
        acceptedAnswer: { "@type": "Answer", text: f.a },
      })),
    },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${serif.variable} ${mono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        {children}
        <Analytics />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </body>
    </html>
  );
}
