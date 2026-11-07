import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { GeistPixelLine } from "geist/font/pixel/line";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";


export const metadata: Metadata = {
  title: "Ridgeline",
  description: "Decentralised search and rescue that keeps working when the radios don't.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`dark ${GeistSans.variable} ${GeistMono.variable} ${GeistPixelLine.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">
        <TooltipProvider delay={300}>{children}</TooltipProvider>
      </body>
    </html>
  );
}
