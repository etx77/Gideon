import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Gideon AI Assistant",
  description: "AI coding and analysis assistant"
};

export default function RootLayout({
  children
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="it">
      <body>{children}</body>
    </html>
  );
}
