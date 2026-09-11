// lib/somnia/config.ts — the PUBLIC, client-safe SDK configuration shared by
// the server exchange (client.ts) and the browser-wallet exchange (browser.ts).
//
// ⚠️ NOTHING SECRET LIVES HERE. No private key, no session key, no indexer auth
// header. Every value below is public infrastructure (chain id, RPC/WS/indexer
// URLs, contract addresses) — safe to include in the browser bundle. This is the
// module browser.ts is allowed to import; client.ts (which holds the server key)
// is NOT. See AGENT.md §5.
//
// The env reads below only take effect server-side (Next.js does not inline
// non-NEXT_PUBLIC_ vars into the client bundle, so in the browser they are
// undefined and fall back to the baked public defaults — which is what we want).

import { SOMNIA_TESTNET_ADDRESSES } from "@somnia-chain/markets-sdk";
import { somniaTestnet } from "viem/chains";

/** Shannon testnet chain id. */
export const CHAIN_ID = 50312;

/** One whole contract = 1e6 base units (collateral is 6-decimals). */
export const ONE = 1_000_000n;

/** Public Shannon endpoints. `wsRpcUrl` is REQUIRED by the SDK with viem's somniaTestnet. */
export const RPC_URL = process.env.RPC_URL || "https://dream-rpc.somnia.network";
export const WS_RPC_URL = process.env.WS_RPC_URL || "wss://api.infra.testnet.somnia.network/ws";
export const INDEXER_URL = process.env.INDEXER_URL || "https://dev.smk.somnia.host/v1/graphql";

/** The viem chain + SDK addresses every exchange (server or browser) is built with. */
export const CHAIN = somniaTestnet;
export const ADDRESSES = SOMNIA_TESTNET_ADDRESSES;

/**
 * Testnet collateral (tUSDC). Discovery is scoped by this (see markets.ts).
 * SDK 0.29 renamed `testUsdc` → `collateral` (testUsdc kept as a legacy alias);
 * both are typed optional, so prefer `collateral`, fall back, and fail loud if
 * neither is present rather than silently comparing against `undefined`.
 */
const _collateral = SOMNIA_TESTNET_ADDRESSES.collateral ?? SOMNIA_TESTNET_ADDRESSES.testUsdc;
if (!_collateral) {
  throw new Error("SDK addresses missing collateral/testUsdc — cannot scope market discovery.");
}
export const COLLATERAL: `0x${string}` = _collateral;

// ─── Market fee (the "market model" cut) ──────────────────────────────────
// Sway takes a small cut on every bet placed, routed ON-CHAIN through the
// protocol's native BUILDER-FEE rail to a treasury address. It is transparent
// and consented (the user's wallet approves the builder once per pool), not a
// hidden rake — and it is DORMANT until a treasury address is configured, so
// the demo runs fee-free out of the box and the fee turns on with one env var.
//
// These are NEXT_PUBLIC_ because a fee-receiving address is public (no secret),
// and the fee must apply identically whether the bet is signed by the browser
// wallet (Path A) or the server key (Path B). Nothing secret is added here.
//
// Unit: bps×1000 (the SDK's docstring: "1500" = 1.5 bps), so 1% = 100 bps =
// 100_000. The BinaryPool freezes a per-pool ceiling at init and reverts
// BuilderFeeExceedsCap above it, so trade.ts reads that ceiling and clamps to
// it, and approves the builder once per pool before charging.

/** Treasury address that receives the market fee. Unset → the fee is disabled. */
export const BUILDER_ADDRESS: `0x${string}` | null =
  (process.env.NEXT_PUBLIC_SWAY_BUILDER_ADDRESS as `0x${string}`) || null;

if (BUILDER_ADDRESS !== null && !/^0x[0-9a-fA-F]{40}$/.test(BUILDER_ADDRESS)) {
  throw new Error("NEXT_PUBLIC_SWAY_BUILDER_ADDRESS is set but is not a valid 0x address.");
}

/** Desired market fee in bps×1000. 100_000 = 100 bps = 1% of the fill. */
export const BUILDER_FEE_BPS_TIMES_1K: bigint = BigInt(
  process.env.NEXT_PUBLIC_SWAY_BUILDER_FEE_BPS_TIMES_1K || 100_000
);

/** Master switch: the fee applies only when explicitly enabled AND a treasury address is set. */
export const BUILDER_FEE_ENABLED: boolean =
  process.env.NEXT_PUBLIC_SWAY_BUILDER_FEE_ENABLED !== "false" && BUILDER_ADDRESS !== null;
