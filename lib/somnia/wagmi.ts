// lib/somnia/wagmi.ts — CLIENT-SAFE wagmi config for Path A (browser wallet).
//
// One wagmi config for the whole app: the Shannon testnet chain (50312). We do
// NOT import from "wagmi/connectors": that barrel re-exports the Coinbase /
// MetaMask / WalletConnect / Base / Safe connectors, each of which pulls an
// OPTIONAL wallet SDK (@coinbase/wallet-sdk, @metamask/sdk, @walletconnect/*, …)
// that we don't install — and Next's webpack fails to bundle the barrel because
// of those unresolved optional imports.
//
// Instead we rely on wagmi's built-in EIP-6963 discovery (multiInjectedProvider
// Discovery defaults to true): every modern injected wallet (MetaMask, Rabby,
// Coinbase Wallet, Brave, Frame) announces itself and shows up in
// useConnect().connectors with type "injected" — exactly what our connect UI
// picks. No connector package, no optional-SDK resolution, nothing secret here.
//
// WalletConnect (mobile QR) is intentionally NOT wired — it's the piece that
// needs a projectId + the heavy optional SDK. Injected wallets cover the demo.

import { createConfig, http } from "wagmi";
import { somniaTestnet } from "viem/chains";
import { RPC_URL } from "./config";

export const wagmiConfig = createConfig({
  chains: [somniaTestnet],
  transports: {
    [somniaTestnet.id]: http(RPC_URL),
  },
  ssr: true,
  // Keep EIP-6963 providers separate so Rabby never falls through to the
  // generic MetaMask injected provider when several wallets are installed.
  multiInjectedProviderDiscovery: true,
});

// Make wagmi's hooks aware of this exact config (typed chains, etc.).
declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
