import type { Metadata } from "next";
import { Instrument_Serif, IBM_Plex_Mono } from "next/font/google";
import Script from "next/script";
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
  "Erase anything from a photo, free and in your browser. Unmark removes AI watermarks from Gemini and Nano Banana, plus objects, people, text, logos and timestamps — your images never leave your device.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Unmark — Free AI Watermark Remover & Magic Eraser",
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
    "magic eraser",
    "AI object remover",
    "remove object from photo",
    "remove person from photo",
    "remove text from image",
    "remove logo from photo",
    "photo cleanup",
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
    title: "Unmark — Free AI Watermark Remover & Magic Eraser",
    description: DESCRIPTION,
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    title: "Unmark — Free AI Watermark Remover & Magic Eraser",
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
        "Magic eraser brush for any unwanted object",
        "Remove people, text, logos and timestamps from photos",
        "On-device processing — no uploads",
        "Automatic AI watermark detection and removal",
        "Add text and captions in multiple styles, including Korean",
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
        {process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID && (
          <Script
            src="https://cloud.umami.is/script.js"
            data-website-id={process.env.NEXT_PUBLIC_UMAMI_WEBSITE_ID}
            // COEP: require-corp (WASM isolation) blocks cross-origin scripts
            // unless loaded via CORS; Umami serves Access-Control-Allow-Origin: *.
            crossOrigin="anonymous"
          />
        )}
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </body>
    </html>
  );
}
