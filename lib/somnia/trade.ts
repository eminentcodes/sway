// lib/somnia/trade.ts — placing a bet and redeeming winnings.
//
// A "bet UP" = buy the Up (YES) outcome token; "bet DOWN" = buy Down (NO).
// We use an IOC taker order (orderType 2) so it crosses immediately or not at
// all — no silent resting order left on the book, which matches the instant,
// tap-and-go UX. Verified shapes against lifecycle.mjs / redeem.mjs (Sprint 0).
//
// WALLET MODEL (D2): this signature accepts an SDK exchange bound to the signer.
// Server/script flows pass sharedExchange(); the browser passes the result of
// bindWallet(walletClient) from lib/somnia/browser.ts — the visitor's own viem
// WalletClient. Keeping the exchange as a param means this function never reaches
// for a global key, and the tradability gate reads through that same exchange.

import { probabilityToPrice } from "@somnia-chain/markets-sdk";
import { ONE, sharedExchange } from "./client";
import { BUILDER_ADDRESS, BUILDER_FEE_BPS_TIMES_1K, BUILDER_FEE_ENABLED } from "./config";
import { isTradable } from "./markets";
import { BetResult, CashOutQuote, CashOutResult, RedeemResult, Side } from "../types";

const SIDE_TO_BUY = { UP: "BUY_YES", DOWN: "BUY_NO" } as const;
const SIDE_TO_SELL = { UP: "SELL_YES", DOWN: "SELL_NO" } as const;

/** Turn any thrown SDK/revert error into one short, user-safe line. */
function friendly(e: any): string {
  const raw = (e?.shortMessage || e?.message || String(e)).split("\n")[0];
  if (/PostOnlyWouldCross/i.test(raw)) return "The market moved — try again.";
  if (/insufficient|balance|allowance/i.test(raw)) return "Not enough testnet balance to place this bet.";
  if (/status|trading|finalized|locked/i.test(raw)) return "This market just closed. Pick another.";
  return "Couldn't place the bet — the market may have moved. Try again.";
}

/**
 * If the market fee is enabled, ensure the signer has approved our treasury
 * (builder) on this pool for at least the fee we intend to charge, and return
 * the CLAMPED fee (bps×1000) to attach to the order. Returns 0n when the fee is
 * off — the order then carries no builder, exactly as before.
 *
 * The BinaryPool freezes a max builder fee at init and reverts
 * `BuilderFeeExceedsCap` above it, so we read that ceiling and clamp to it.
 * Approval is per-pool (and pools are recycled across markets), so this cost is
 * paid once per pool, then amortized across every bet on it. Any failure in the
 * fee path falls back to a fee-free order — the core bet must never break
 * because of the optional fee rail.
 */
async function ensureBuilderFee(ex: any, pool: string, address: string): Promise<bigint> {
  if (!BUILDER_FEE_ENABLED || !BUILDER_ADDRESS) return 0n;
  try {
    const ceiling: bigint = await ex.trader.getMaxBuilderFeeBpsTimes1k(pool);
    const fee = ceiling < BUILDER_FEE_BPS_TIMES_1K ? ceiling : BUILDER_FEE_BPS_TIMES_1K;
    if (fee <= 0n) return 0n; // this pool allows no builder fee — skip rather than revert
    const approved: bigint = await ex.trader.getEffectiveBuilderApproval({
      pool,
      user: address,
      builder: BUILDER_ADDRESS,
    });
    if (approved < fee) {
      await ex.trader.approveBuilder({ pool, builder: BUILDER_ADDRESS, maxFeeBpsTimes1k: fee });
    }
    return fee;
  } catch {
    return 0n;
  }
}

/**
 * Place a bet on a market. Buys `amountUsd` worth of the chosen side as a taker
 * (IOC) at up to 0.99 so it crosses whatever liquidity exists.
 *
 * @param exchange optional SDK exchange bound to the signer; defaults to the
 *   env-key shared exchange (server/scripts).
 */
export async function placeBet(
  args: { marketId: string; pool: string; side: Side; amountUsd: number },
  exchange?: ReturnType<typeof sharedExchange>
): Promise<BetResult> {
  const { marketId, pool, side, amountUsd } = args;
  const base = { ok: false as const, filledQty: 0, fillPrice: null, side, marketId };
  const exch = exchange || sharedExchange();

  // Gate on live on-chain status — never trust an unexpired timestamp alone.
  // Read through the SAME exchange we'll sign with, so a browser-wallet bet
  // never reaches for the server key.
  if (!(await isTradable(marketId, exch))) {
    return { ...base, error: "This market isn't open for trading right now." };
  }
  if (!(amountUsd > 0)) {
    return { ...base, error: "Enter an amount greater than zero." };
  }

  const { ex, address } = exch;
  const quantity = BigInt(Math.round(amountUsd)) * ONE;

  try {
    // Attach the market fee if enabled (clamped to the pool ceiling; approves
    // the treasury once per pool). 0n → a plain, fee-free order like before.
    const feeBps = await ensureBuilderFee(ex, pool, address);
    const order = await ex.trader.placeOrder({
      pool: pool as `0x${string}`,
      side: SIDE_TO_BUY[side],
      price: probabilityToPrice(0.99), // cross up to near-certainty
      quantity,
      orderType: 2, // IOC — fill now or cancel the remainder
      ...(feeBps > 0n && BUILDER_ADDRESS
        ? { builder: BUILDER_ADDRESS, builderFeeBpsTimes1k: feeBps }
        : {}),
    });
    const fill = (order.fills || [])[0];
    const filledQty = fill ? Number(fill.quantityFilled) / 1e6 : 0;
    const fillPrice = fill ? Number(fill.fillPrice) / 1e6 : null;
    // Disclose the fee: exact rate (bps×1000 → fraction is /1e7), and an
    // estimated collateral amount from the fill notional (qty × price).
    const feeRate = feeBps > 0n ? Number(feeBps) / 1e7 : undefined;
    const fee =
      feeRate != null && fillPrice != null
        ? Math.round(filledQty * fillPrice * feeRate * 1e6) / 1e6
        : undefined;
    return { ok: true, txHash: order.hash, filledQty, fillPrice, side, marketId, feeRate, fee };
  } catch (e) {
    return { ...base, error: friendly(e) };
  }
}

/**
 * Live cash-out quote for an open position. Reads the outcome-token balance the
 * wallet holds on `side` (UP = YES tokens, DOWN = NO tokens), walks the resting
 * BIDS on that side, and estimates the collateral a sell-now would return.
 *
 * This is what makes Sway feel like a *market*, not a parimutuel pool: you can
 * leave a guess before the round resolves. The honest limitation is a one-sided
 * book — if nobody is bidding on your side there is nothing to sell into, so
 * `canCashOut` is false and the UI should say "no offers yet" rather than fake a
 * price. (A parimutuel pool structurally can't offer this at all.)
 *
 * @param exchange optional SDK exchange bound to the signer; defaults to the
 *   env-key shared exchange. Pass bindWallet(walletClient) to quote the visitor's
 *   OWN position from the browser.
 *
 * Reading a balance is a public on-chain call (no signing), so `args.account`
 * can override whose position to quote. That lets a SERVER route quote the
 * visitor's address by param — dodging the browser-CORS risk on the indexer read
 * (AGENT.md §3) — without ever holding the visitor's key. Defaults to the
 * exchange's own address.
 */
export async function positionValue(
  args: { marketId: string; pool: string; side: Side; account?: string },
  exchange?: ReturnType<typeof sharedExchange>
): Promise<CashOutQuote> {
  const { marketId, pool, side } = args;
  const { ex, address } = exchange || sharedExchange();
  // account may be overridden to quote any address (a pure read). Cast at this
  // boundary like `pool` below — the route regex-validates it, `address` is
  // already an Address, and getOutcomeBalance wants viem's `0x${string}`.
  const account = (args.account || address) as `0x${string}`;
  const base: CashOutQuote = {
    marketId,
    side,
    heldQty: 0,
    bestBid: null,
    estProceeds: 0,
    canCashOut: false,
    partial: false,
  };

  try {
    const mo = await ex.client.getMarketOnchain(marketId as `0x${string}`);
    const id = side === "UP" ? mo.yesId : mo.noId;
    const held: bigint = await ex.client.getOutcomeBalance({
      outcomeToken: mo.outcomeToken,
      account,
      id: BigInt(id),
    });
    if (held <= 0n) return base;
    const heldQty = Number(held) / 1e6;

    // Best-first bids on the held side. UP position sells into YES bids; DOWN
    // sells into NO bids (NO prices are the YES book inverted, handled by the SDK).
    const book = await ex.client.getBinaryOrderBook(pool as `0x${string}`);
    const bids = side === "UP" ? book.yesBids : book.noBids;
    if (!bids || bids.length === 0) return { ...base, heldQty };

    // Walk the bids up to the held size for a realistic blended proceeds.
    let remaining = held;
    let proceeds = 0n; // raw collateral units (6dp)
    for (const lvl of bids) {
      if (remaining <= 0n) break;
      const take = remaining < lvl.quantity ? remaining : lvl.quantity;
      proceeds += (take * lvl.price) / ONE;
      remaining -= take;
    }

    return {
      marketId,
      side,
      heldQty,
      bestBid: Number(bids[0].price) / 1e6,
      estProceeds: Number(proceeds) / 1e6,
      canCashOut: proceeds > 0n,
      partial: remaining > 0n,
    };
  } catch {
    return base;
  }
}

/**
 * Cash out an open position: sell the full held balance of the side's outcome
 * token back to the book as an IOC taker (SELL_YES for UP, SELL_NO for DOWN) at
 * a low crossing floor, so it takes whatever bids exist right now and cancels
 * the rest. The taker mirror of placeBet, opposite direction.
 *
 * No market fee on exits — the cut is on entry only ("a cut for every bet
 * placed"). Size is floored to the pool's lot grid and gated on minQuantity so
 * the pool never rejects it; `soldQty`/`proceeds` report what actually crossed,
 * which may be a partial unwind on a thin book.
 */
export async function sellPosition(
  args: { marketId: string; pool: string; side: Side },
  exchange?: ReturnType<typeof sharedExchange>
): Promise<CashOutResult> {
  const { marketId, pool, side } = args;
  const base = { ok: false as const, soldQty: 0, fillPrice: null, proceeds: 0, side, marketId };
  const { ex, address } = exchange || sharedExchange();

  try {
    const mo = await ex.client.getMarketOnchain(marketId as `0x${string}`);
    const id = side === "UP" ? mo.yesId : mo.noId;
    const held: bigint = await ex.client.getOutcomeBalance({
      outcomeToken: mo.outcomeToken,
      account: address,
      id: BigInt(id),
    });
    if (held <= 0n) return { ...base, error: "You have no position to cash out on this side." };

    // Round the sell size DOWN to the pool's lot grid; refuse below minQuantity.
    const params = await ex.client.getBinaryBookParams(pool as `0x${string}`);
    const lot = params.lotSize > 0n ? params.lotSize : 1n;
    const quantity = (held / lot) * lot;
    if (quantity <= 0n || quantity < params.minQuantity) {
      return { ...base, error: "Position too small to cash out." };
    }

    // Floor price: near-zero probability, aligned down to a tick, so the IOC
    // crosses into any resting bid (we accept whatever the book pays above it).
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
    let proceedsRaw = 0n; // raw collateral units (6dp)
    for (const f of order.fills || []) {
      const q = BigInt(f.quantityFilled);
      soldRaw += q;
      proceedsRaw += (q * BigInt(f.fillPrice)) / ONE;
    }
    // VWAP as probability: collateral-per-token = (Σ qty·price) / Σ qty, both 1e6-scaled.
    const fillPrice = soldRaw > 0n ? Number(proceedsRaw) / Number(soldRaw) : null;

    return {
      ok: true,
      txHash: order.hash,
      soldQty: Number(soldRaw) / 1e6,
      fillPrice,
      proceeds: Number(proceedsRaw) / 1e6,
      side,
      marketId,
    };
  } catch (e) {
    return { ...base, error: friendly(e) };
  }
}

/**
 * Scan recently-settled markets and redeem any winning positions the wallet holds.
 * Settled markets leave the live list, so redemption is its own flow (not discover).
 * `marketIds` are the markets the user actually bet on (tracked app-side).
 */
export async function redeemWinnings(
  marketIds: string[],
  exchange?: ReturnType<typeof sharedExchange>
): Promise<RedeemResult> {
  const { ex, address } = exchange || sharedExchange();
  const claims: RedeemResult["claims"] = [];
  let totalClaimed = 0;

  for (const marketId of marketIds) {
    try {
      const mo = await ex.client.getMarketOnchain(marketId as `0x${string}`);
      if (!mo.finalized && !mo.isResolved && !mo.isVoided) continue; // not settled yet

      const balOf = (id: any) =>
        ex.client.getOutcomeBalance({ outcomeToken: mo.outcomeToken, account: address, id: BigInt(id) });

      if (mo.isVoided) {
        // Voided: both sides refund at 0.5.
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
