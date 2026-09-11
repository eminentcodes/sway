// lib/somnia/browser.ts — CLIENT-SAFE. Signs bets/redeems with the visitor's
// OWN connected wallet (a viem/wagmi WalletClient) instead of the shared server
// key, so the leaderboard identity is really theirs.
//
// ⚠️ SAFE TO IMPORT FROM A CLIENT COMPONENT. It imports only the public config
// (config.ts) + the SDK — never client.ts, never a private key, never the
// indexer auth header. Wallet signing goes through the user's injected wallet.
// See AGENT.md §5.
//
// HOW THE SDK SUPPORTS THIS (verified against the SDK's own .d.ts):
//   SomniaMarketsConfig accepts a `walletClient` signer, and
//   ex.setSigner({ walletClient }) rebinds it after construction. The SDK docs
//   describe exactly our flow: "Browser apps construct the exchange at boot for
//   public reads, then call this when the user's wallet connects — and again
//   with `{}` on disconnect."
//
// So we keep ONE exchange (one WebSocket) for the whole tab and just swap the
// signer on connect/disconnect — never build a fresh SomniaMarkets per tap (that
// would leak a socket every bet).

import { SomniaMarkets } from "@somnia-chain/markets-sdk";
import type { WalletClient } from "viem";
import { CHAIN, ADDRESSES, WS_RPC_URL, INDEXER_URL } from "./config";

/** The single tab-lived exchange. Read-only until a wallet binds. */
let _ex: SomniaMarkets | null = null;

/**
 * The shared browser exchange (lazily built, one WebSocket for the tab).
 * Read-only until {@link bindWallet} is called. Exposed for read-side use if a
 * server component/route isn't handy; prefer the /api/* routes for reads.
 */
export function browserExchange(): SomniaMarkets {
  if (!_ex) {
    _ex = new SomniaMarkets({
      chain: CHAIN,
      addresses: ADDRESSES,
      wsRpcUrl: WS_RPC_URL, // REQUIRED with viem's somniaTestnet
      indexerUrl: INDEXER_URL,
    });
  }
  return _ex;
}

/**
 * Bind the connected wallet so writes sign as the visitor. Call this once the
 * wallet connects (and again if the account changes). Returns the same
 * `{ ex, address }` shape `placeBet()` / `redeemWinnings()` accept:
 *
 * ```ts
 * const signer = bindWallet(walletClient);          // on connect
 * await placeBet({ marketId, pool, side, amountUsd }, signer);
 * ```
 *
 * `walletClient.account` must be set — wagmi's `useWalletClient()` provides it
 * once connected.
 */
export function bindWallet(walletClient: WalletClient): { ex: SomniaMarkets; address: `0x${string}` } {
  const address = walletClient.account?.address;
  if (!address) {
    throw new Error("Wallet not connected — connect a wallet before placing a bet.");
  }
  const ex = browserExchange();
  ex.setSigner({ walletClient });
  return { ex, address };
}

/** Return the exchange to read-only. Call on wallet disconnect. */
export function unbindWallet(): void {
  browserExchange().setSigner({});
}

/** The bound wallet address, or undefined if read-only. */
export function boundAddress(): `0x${string}` | undefined {
  return _ex?.walletAddress;
}
