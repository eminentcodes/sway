// scripts/trade-live.ts — end-to-end LIVE trade test. REQUIRES faucet funds
// (tUSDC + STT) in the dev wallet. Proves placeBet() works against a real round.
//
// Run once the wallet is funded:  npm run trade:live
//
// This is the one step gated on the Telegram faucet. Everything else (smoke)
// runs without funds. It mints a set, places a small UP bet as a taker, and
// prints the fill — then you can run redeem after the round resolves.
import { config } from "dotenv";
// Env precedence (dotenv won't override an already-set var): repo-root .env.local
// → .env, then _template/.env as a fallback so a fresh clone and the local dev
// setup both work.
for (const p of [".env.local", ".env", "_template/.env"]) config({ path: new URL(`../${p}`, import.meta.url) });

import { nextRoundFor, getRounds } from "../lib/somnia/rounds.ts";
import { placeBet } from "../lib/somnia/trade.ts";
import { sharedExchange, ONE } from "../lib/somnia/client.ts";

// Pick the soonest open round on either asset.
const rounds = await getRounds();
const open = rounds.find((r) => r.phase === "NEXT");
if (!open) {
  console.log("No open (NEXT) round right now — try again in a minute.");
  process.exit(0);
}
console.log(`Open round: ${open.asset}  expires in ${Math.round(open.secondsToExpiry / 60)}min`);
console.log(`  up=${open.upProbability}  payout up/down = ${open.upPayout}x / ${open.downPayout}x`);

// Mint a small set first so we have inventory + the market is warm.
const { ex } = sharedExchange();
try {
  const mint = await ex.trader.mintSet({ pool: open.pool as `0x${string}`, amount: 2n * ONE });
  console.log(`mintSet ok: ${mint.hash}`);
} catch (e: any) {
  console.error("mintSet failed — is the wallet funded with tUSDC + STT?");
  console.error("  faucet: https://t.me/+XHq0F0JXMyhmMzM0");
  console.error("  " + (e?.shortMessage || e?.message));
  process.exit(1);
}

// Place a 1-unit UP bet through our real core function.
const res = await placeBet({ marketId: open.marketId, pool: open.pool, side: "UP", amountUsd: 1 });
console.log("\nplaceBet result:", JSON.stringify(res, null, 2));

if (res.ok) {
  console.log(`\n✅ LIVE TRADE CONFIRMED. Filled ${res.filledQty} @ ${res.fillPrice}. tx=${res.txHash}`);
  console.log(`After the round resolves (~${Math.round(open.secondsToExpiry / 60)}min), redeem via redeemWinnings([${open.marketId.slice(0,10)}…]).`);
} else {
  console.log(`\n⚠️  placeBet returned ok=false: ${res.error}`);
  console.log("(May be an empty book — no counterparty to cross. Try the other asset or wait for liquidity.)");
}
process.exit(res.ok ? 0 : 1);
