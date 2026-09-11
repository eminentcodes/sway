// Root layout. Minimal scaffold — GPT owns the real UI shell (see AGENT.md §2).
// Kept intentionally bare so the app compiles and API routes work before the
// frontend lands.
import type { ReactNode } from "react";

export const metadata = {
  title: "Sway ",
  description: "Tap UP or DOWN on live crypto rounds. Powered by DreamDEX Event Contracts on Somnia.",
  icons: { icon: "/favicon.svg" },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
