// lib/somnia/trade-browser.ts — CLIENT-SAFE writes for Path A (browser wallet).
//
// ⚠️ SAFE TO IMPORT FROM A CLIENT COMPONENT. It imports ONLY the public config
// (config.ts) + the SDK — never client.ts, never a private key. This is the
// browser twin of trade.ts: the SAME verified order logic, but it ALWAYS signs
// through a wallet-bound exchange (the `{ ex, address }` that bindWallet returns)
// and NEVER falls back to the server key. Keeping it separate is deliberate —
// trade.ts statically imports client.ts (the key path), so it can't cross into
// the browser bundle. See AGENT.md §5 and client.ts's header.
//
// Reads used here (getMarketOnchain, getOutcomeBalance, order book/params) are
// public chain calls; the writes (placeOrder/redeem) sign with the visitor's own
// wallet. The tradability gate reads through that SAME exchange, so a browser bet
// never reaches for a global key.

import { probabilityToPrice } from "@somnia-chain/markets-sdk";
import type { SomniaMarkets } from "@somnia-chain/markets-sdk";
import { ONE, BUILDER_ADDRESS, BUILDER_FEE_BPS_TIMES_1K, BUILDER_FEE_ENABLED } from "./config";
import { BetResult, CashOutResult, MarketStatus, RedeemResult, Side } from "../types";

/** A signer-bound SDK exchange — exactly the shape bindWallet(walletClient) returns. */
export type Exchange = { ex: SomniaMarkets; address: `0x${string}` };

const SIDE_TO_BUY = { UP: "BUY_YES", DOWN: "BUY_NO" } as const;
const SIDE_TO_SELL = { UP: "SELL_YES", DOWN: "SELL_NO" } as const;

/** Turn any thrown SDK/revert error into one short, user-safe line. */
function friendly(e: any): string {
  const raw = (e?.shortMessage || e?.message || String(e)).split("\n")[0];
  if (/User rejected|denied|rejected the request/i.test(raw)) return "You cancelled the request in your wallet.";
  if (/PostOnlyWouldCross/i.test(raw)) return "The market moved — try again.";
  if (/insufficient|balance|allowance/i.test(raw)) return "Not enough testnet balance to place this bet.";
  if (/status|trading|finalized|locked/i.test(raw)) return "This market just closed. Pick another.";
  return "Couldn't place the bet — the market may have moved. Try again.";
}

/** Tradability gate through the bound exchange (public read, no signing). */
async function isTradableVia(ex: SomniaMarkets, marketId: string): Promise<boolean> {
  try {
    const mo = await ex.client.getMarketOnchain(marketId as `0x${string}`);
    return !mo.finalized && Number(mo.status) === MarketStatus.Trading;
  } catch {
    return false;
  }
}

/**
 * If the market fee is enabled, ensure the signer has approved our treasury
 * (builder) on this pool for at least the fee we intend to charge, and return the
 * CLAMPED fee (bps×1000). Returns 0n when the fee is off. Any failure falls back
 * to a fee-free order — the core bet must never break because of the optional fee.
 */
async function ensureBuilderFee(ex: any, pool: string, address: string): Promise<bigint> {
  if (!BUILDER_FEE_ENABLED || !BUILDER_ADDRESS) return 0n;
  try {
    const ceiling: bigint = await ex.trader.getMaxBuilderFeeBpsTimes1k(pool);
    const fee = ceiling < BUILDER_FEE_BPS_TIMES_1K ? ceiling : BUILDER_FEE_BPS_TIMES_1K;
    if (fee <= 0n) return 0n;
    const approved: bigint = await ex.trader.getEffectiveBuilderApproval({ pool, user: address, builder: BUILDER_ADDRESS });
    if (approved < fee) {
      await ex.trader.approveBuilder({ pool, builder: BUILDER_ADDRESS, maxFeeBpsTimes1k: fee });
    }
    return fee;
  } catch {
    return 0n;
  }
}

/**
 * Place a bet, signing with the visitor's connected wallet. Buys `amountUsd`
 * worth of the chosen side as an IOC taker (orderType 2) at up to 0.99 so it
 * crosses whatever liquidity exists. Mirrors trade.ts::placeBet.
 */
export async function placeBet(
  args: { marketId: string; pool: string; side: Side; amountUsd: number },
  exch: Exchange
): Promise<BetResult> {
  const { marketId, pool, side, amountUsd } = args;
  const base = { ok: false as const, filledQty: 0, fillPrice: null, side, marketId };
  const { ex, address } = exch;

  if (!(await isTradableVia(ex, marketId))) {
    return { ...base, error: "This market isn't open for trading right now." };
  }
  if (!(amountUsd > 0)) {
    return { ...base, error: "Enter an amount greater than zero." };
  }

  const quantity = BigInt(Math.round(amountUsd)) * ONE;
  try {
    const feeBps = await ensureBuilderFee(ex, pool, address);
    const order = await ex.trader.placeOrder({
      pool: pool as `0x${string}`,
      side: SIDE_TO_BUY[side],
      price: probabilityToPrice(0.99),
      quantity,
      orderType: 2, // IOC — fill now or cancel the remainder
      ...(feeBps > 0n && BUILDER_ADDRESS ? { builder: BUILDER_ADDRESS, builderFeeBpsTimes1k: feeBps } : {}),
    });
    const fill = (order.fills || [])[0];
    const filledQty = fill ? Number(fill.quantityFilled) / 1e6 : 0;
    const fillPrice = fill ? Number(fill.fillPrice) / 1e6 : null;
    const feeRate = feeBps > 0n ? Number(feeBps) / 1e7 : undefined;
    const fee = feeRate != null && fillPrice != null ? Math.round(filledQty * fillPrice * feeRate * 1e6) / 1e6 : undefined;
    return { ok: true, txHash: order.hash, filledQty, fillPrice, side, marketId, feeRate, fee };
  } catch (e) {
    return { ...base, error: friendly(e) };
  }
}

/**
 * Cash out an open position: sell the full held balance of the side's outcome
 * token back to the book as an IOC taker at a low crossing floor. Mirrors
 * trade.ts::sellPosition. No fee on exits.
 */
export async function sellPosition(
  args: { marketId: string; pool: string; side: Side },
  exch: Exchange
): Promise<CashOutResult> {
  const { marketId, pool, side } = args;
  const base = { ok: false as const, soldQty: 0, fillPrice: null, proceeds: 0, side, marketId };
  const { ex, address } = exch;

  try {
    const mo = await ex.client.getMarketOnchain(marketId as `0x${string}`);
    const id = side === "UP" ? mo.yesId : mo.noId;
    const held: bigint = await ex.client.getOutcomeBalance({ outcomeToken: mo.outcomeToken, account: address, id: BigInt(id) });
    if (held <= 0n) return { ...base, error: "You have no position to cash out on this side." };

    const params = await ex.client.getBinaryBookParams(pool as `0x${string}`);
    const lot = params.lotSize > 0n ? params.lotSize : 1n;
    const quantity = (held / lot) * lot;
    if (quantity <= 0n || quantity < params.minQuantity) {
      return { ...base, error: "Position too small to cash out." };
    }

    const tick = params.tickSize > 0n ? params.tickSize : 1n;
    let floor = (probabilityToPrice(0.01) / tick) * tick;
    if (floor <= 0n) floor = tick;

    const order = await ex.trader.placeOrder({
      pool: pool as `0x${string}`,
      side: SIDE_TO_SELL[side],
      price: floor,
      quantity,
      orderType: 2, // IOC
    });

    let soldRaw = 0n;
    let proceedsRaw = 0n;
    for (const f of order.fills || []) {
      const q = BigInt(f.quantityFilled);
      soldRaw += q;
      proceedsRaw += (q * BigInt(f.fillPrice)) / ONE;
    }
    const fillPrice = soldRaw > 0n ? Number(proceedsRaw) / Number(soldRaw) : null;

    return { ok: true, txHash: order.hash, soldQty: Number(soldRaw) / 1e6, fillPrice, proceeds: Number(proceedsRaw) / 1e6, side, marketId };
  } catch (e) {
    return { ...base, error: friendly(e) };
  }
}

/**
 * Redeem any winning positions the connected wallet holds across `marketIds`.
 * Mirrors trade.ts::redeemWinnings. Settled markets leave the live feed, so this
 * is driven by the markets the app tracked the user betting on.
 */
export async function redeemWinnings(marketIds: string[], exch: Exchange): Promise<RedeemResult> {
  const { ex, address } = exch;
  const claims: RedeemResult["claims"] = [];
  let totalClaimed = 0;

  for (const marketId of marketIds) {
    try {
      const mo = await ex.client.getMarketOnchain(marketId as `0x${string}`);
      if (!mo.finalized && !mo.isResolved && !mo.isVoided) continue; // not settled yet

      const balOf = (id: any) => ex.client.getOutcomeBalance({ outcomeToken: mo.outcomeToken, account: address, id: BigInt(id) });

      if (mo.isVoided) {
        for (const [idx, id, side] of [[0, mo.yesId, "UP"], [1, mo.noId, "DOWN"]] as const) {
          const amount = await balOf(id);
          if (amount > 0n) {
            const r = await ex.trader.redeem({ marketId: marketId as `0x${string}`, outcomeIdx: idx, amount, outcomeToken: mo.outcomeToken });
            const human = Number(amount) / 1e6;
            totalClaimed += human * 0.5;
            claims.push({ marketId, asset: "", side, amount: human * 0.5, txHash: r.hash });
          }
        }
      } else {
        const winner = Number(mo.winningOutcome); // 0 = Up, 1 = Down
        const amount = await balOf(winner === 0 ? mo.yesId : mo.noId);
        if (amount > 0n) {
          const r = await ex.trader.redeem({ marketId: marketId as `0x${string}`, outcomeIdx: winner as 0 | 1, amount, outcomeToken: mo.outcomeToken });
          const human = Number(amount) / 1e6;
          totalClaimed += human;
          claims.push({ marketId, asset: "", side: winner === 0 ? "UP" : "DOWN", amount: human, txHash: r.hash });
        }
      }
    } catch {
      // skip this market — a bad read shouldn't abort the whole redeem sweep.
    }
  }

  return { ok: true, claims, totalClaimed };
}
