"use client";

// app/(ui)/providers.tsx — client-side wallet + data providers, mounted once in
// the (ui) layout so both the landing page and /app share one wallet connection.
// WagmiProvider gives the whole tree the Path A wallet (connect / account / chain
// / walletClient); QueryClientProvider is wagmi v2's required data layer.
//
// No visual components here — connection UI lives in the app's own HTML so the
// frontend owns all styling.

import { useState, type ReactNode } from "react";
import { WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { wagmiConfig } from "../../lib/somnia/wagmi";

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
