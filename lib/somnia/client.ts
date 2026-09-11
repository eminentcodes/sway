// lib/somnia/client.ts — SERVER-SIDE SDK + viem configuration. This module holds
// the private-key path, so it must never be imported into the browser bundle.
// Verified against the starter template's client.mjs (Sprint 0).
//
// Two client roles (from the SDK):
//   ex.client  -> reads  (getMarketOnchain, getOutcomeBalance, getAllOpenOrdersOnchain, listBinaryMarkets)
//   ex.trader  -> writes (mintSet, burnSet, placeOrder, cancelOrder, redeem)
//
// WALLET MODEL (decision D2):
//   - Server reads + scripts build the SDK from PRIVATE_KEY in the environment
//     (makeExchange / sharedExchange below).
//   - User-signed writes from the browser go through lib/somnia/browser.ts, which
//     binds the visitor's viem WalletClient — it imports the PUBLIC config from
//     config.ts and NEVER this file. Keep the split: no secret leaves the server.
//
// The shared public constants (chain, addresses, URLs, COLLATERAL, ONE, CHAIN_ID)
// live in config.ts and are re-exported here, so existing importers of this
// module are unchanged.

import { SomniaMarkets } from "@somnia-chain/markets-sdk";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAIN, ADDRESSES, RPC_URL, WS_RPC_URL, INDEXER_URL } from "./config";

// Re-export the public constants so `import { ... } from "./client.js"` keeps
// working for markets.ts (COLLATERAL), trade.ts (ONE), scripts, etc.
export { CHAIN_ID, ONE, COLLATERAL } from "./config";

/** Read-only chain client for raw log/state reads the SDK doesn't cover (e.g. discovery). */
export const pub = createPublicClient({
  chain: CHAIN,
  transport: http(RPC_URL),
});

/**
 * Build an SDK exchange object bound to a private key.
 * `wsRpcUrl` is REQUIRED — loadMarkets()/watches throw without it (verified gotcha).
 * Used by scripts and server-side flows. Browser writes go through
 * lib/somnia/browser.ts (a viem WalletClient) rather than a key.
 */
export function makeExchange(privateKey: `0x${string}` | string) {
  if (!privateKey || privateKey === "0x...") {
    throw new Error("Missing PRIVATE_KEY — set a funded Shannon testnet key in the environment.");
  }
  const address = privateKeyToAccount(privateKey as `0x${string}`).address;
  const ex = new SomniaMarkets({
    chain: CHAIN,
    addresses: ADDRESSES,
    privateKey: privateKey as `0x${string}`,
    wsRpcUrl: WS_RPC_URL,
    indexerUrl: INDEXER_URL,
  });
  return { ex, address };
}

/**
 * Lazily-built shared exchange from env PRIVATE_KEY, for server reads/scripts.
 * Throws only when first used without a key, so importing this module is always safe.
 */
let _shared: ReturnType<typeof makeExchange> | null = null;
export function sharedExchange() {
  if (!_shared) _shared = makeExchange(process.env.PRIVATE_KEY || "");
  return _shared;
}

/**
 * Lazily-built KEYLESS exchange for PUBLIC READS (market discovery, order books,
 * on-chain status, candles). Reads are public chain data and need no signing key,
 * so the home feed and leaderboard render with ZERO env config — a fresh clone of
 * the (mandatory public) repo, or any visitor with no wallet, still sees live
 * markets. Only WRITES (placeBet's server path, /api/bet) need sharedExchange()'s
 * key. Mirrors browser.ts's keyless construction; one instance reused per process.
 */
let _read: SomniaMarkets | null = null;
export function readExchange(): SomniaMarkets {
  if (!_read) {
    _read = new SomniaMarkets({
      chain: CHAIN,
      addresses: ADDRESSES,
      wsRpcUrl: WS_RPC_URL, // REQUIRED by the SDK with viem's somniaTestnet
      indexerUrl: INDEXER_URL,
    });
  }
  return _read;
}
