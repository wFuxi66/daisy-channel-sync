import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Daisy — Canaux de vente",
  description: "Synchronisation des disponibilités avec les plateformes partenaires",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="fr">
      <body className="min-h-screen bg-stone-50 text-stone-900 antialiased">{children}</body>
    </html>
  );
}
