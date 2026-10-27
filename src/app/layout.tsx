import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Nexo League Hub", template: "%s · Nexo League Hub" },
  description: "Gestion de ligues et championnats simracing. Aucune affiliation officielle avec iRacing.",
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#0d0f13" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
