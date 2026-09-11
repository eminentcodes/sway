// lib/somnia/rounds.ts — the PancakeSwap-style round layer.
//
// A "round" is just a market window dressed for the UI: NEXT (open, enterable),
// LIVE (locked, running), EXPIRED (resolved). We also compute the locked-at-entry
// payout multiplier — the order-book advantage over a parimutuel pool: you know
// your exact multiple the instant you tap.
//
// Built on markets.ts (discovery + status) — this module adds framing, not new
// chain access, so it stays cheap and testable.

import { CANDLE_INTERVALS } from "@somnia-chain/markets-sdk";
import { discoverMarkets, getMarket } from "./markets";
import { readExchange } from "./client";
import { Market, MarketStatus, ProbabilityPoint, Round, RoundPhase, Side } from "../types";

/** Classify a market into a round phase from its status + expiry. */
export function phaseOf(m: Pick<Market, "status" | "expiry">): RoundPhase {
  const now = Math.floor(Date.now() / 1000);
  if (m.status === MarketStatus.Trading && m.expiry > now) return "NEXT";
  if (m.status >= MarketStatus.Resolved) return "EXPIRED"; // Resolved(4) or Voided(5)
  // Locked / Settling, or Trading-but-past-expiry → the round is running, not enterable.
  return "LIVE";
}

/** Payout multiplier for a given entry probability. 1/price, capped for display sanity. */
function payout(prob: number | null): number | null {
  if (prob == null || prob <= 0 || prob >= 1) return null;
  return Math.round((1 / prob) * 100) / 100; // 2 dp, e.g. 2.5
}

/** Turn a normalized Market into a UI Round (adds phase, countdown, payouts, winner). */
export async function toRound(m: Market): Promise<Round> {
  const now = Math.floor(Date.now() / 1000);
  const phase = phaseOf(m);

  let winner: Side | null = null;
  if (phase === "EXPIRED") winner = await winnerOf(m.marketId);

  const up = m.upProbability;
  return {
    marketId: m.marketId,
    pool: m.pool,
    asset: m.asset,
    intervalSec: m.intervalSec,
    expiry: m.expiry,
    phase,
    status: m.status,
    secondsToExpiry: m.expiry - now,
    upProbability: up,
    upPayout: payout(up),
    downPayout: payout(up == null ? null : 1 - up),
    winner,
  };
}

/** Resolved winner for a settled market, or null if not yet resolved / voided. */
// A resolved market's winner is immutable, so once we've read it we never need to
// hit the chain for that market again. This memo removes a per-expired-market RPC
// call from every feed refresh — the biggest avoidable cost in getRounds().
const winnerCache = new Map<string, Side>();

export async function winnerOf(marketId: string): Promise<Side | null> {
  const memoized = winnerCache.get(marketId);
  if (memoized) return memoized;
  const ex = readExchange(); // public read — no signing key needed
  try {
    const mo = await ex.client.getMarketOnchain(marketId as `0x${string}`);
    if (mo.isVoided) return null;
    if (!mo.finalized && !mo.isResolved) return null;
    const decided: Side = Number(mo.winningOutcome) === 0 ? "UP" : "DOWN";
    winnerCache.set(marketId, decided); // immutable from here on
    return decided;
  } catch {
    return null;
  }
}

/**
 * All current rounds, grouped by asset, newest-first within each asset.
 * This is the primary feed the home screen renders.
 */
export async function getRounds(): Promise<Round[]> {
  const markets = await discoverMarkets();
  const rounds = await Promise.all(markets.map(toRound));
  // Enterable (NEXT) first, then LIVE, then EXPIRED.
  const order: Record<RoundPhase, number> = { NEXT: 0, LIVE: 1, EXPIRED: 2 };
  return rounds.sort((a, b) => {
    if (order[a.phase] !== order[b.phase]) return order[a.phase] - order[b.phase];
    // Within the enterable (NEXT) phase, lead with the FASTEST-cadence round: it
    // resolves soonest after a tap — the most engaging card and the clearest
    // showcase of Somnia's sub-second settlement. Then break ties by soonest expiry.
    if (a.phase === "NEXT" && a.intervalSec !== b.intervalSec) {
      return a.intervalSec - b.intervalSec;
    }
    return a.secondsToExpiry - b.secondsToExpiry;
  });
}

/** The single open (enterable) round for an asset, or null if none is open. */
export async function nextRoundFor(asset: string): Promise<Round | null> {
  const rounds = await getRounds();
  return rounds.find((r) => r.asset === asset && r.phase === "NEXT") || null;
}

/** One round by market id (fresh read). */
export async function getRound(marketId: string): Promise<Round> {
  return toRound(await getMarket(marketId));
}

/**
 * "Sway the line" — the round's implied-probability history as OHLC points.
 *
 * The order-book price of the UP (YES) token IS a live, money-weighted
 * probability, so the OHLC of price over time is the OHLC of the *crowd's
 * belief* the market goes up. Charting it turns Sway from a tap-and-wait game
 * into something you can read a story off — the line moving toward your side is
 * the crowd swaying your way. (A parimutuel pool has no such price to plot.)
 *
 * Candle prices come back on the YES-probability scale (raw 1e6), same as the
 * book, so each field divides by 1e6 into a clean 0..1 probability.
 *
 * Pools are recycled across successive markets, so the pool's candle history
 * spans more than this round. We scope to THIS round's trading window
 * [expiry − intervalSec, expiry] via from/to, so the series is just this round's
 * belief curve, not the pool's whole past.
 *
 * @param intervalSec candle bucket size in seconds. Must be one the indexer
 *   materializes (CANDLE_INTERVALS); anything else snaps to 60 (1-minute).
 */
export async function getProbabilitySeries(
  marketId: string,
  intervalSec: number = 60
): Promise<ProbabilityPoint[]> {
  const ex = readExchange(); // public read — no signing key needed
  // Only ask for a bucket the indexer actually rolls up; default to 1-minute.
  const bucket = (CANDLE_INTERVALS as readonly number[]).includes(intervalSec) ? intervalSec : 60;
  try {
    const m = await getMarket(marketId);
    const windowOpen = m.expiry - m.intervalSec; // this round's trading-window start
    const candles = await ex.client.getCandles(m.pool, bucket, {
      from: windowOpen,
      to: m.expiry,
      limit: 1000,
    });
    // Oldest-first already (getCandles guarantees it). Raw 1e6 → 0..1 probability.
    return candles.map((c: any) => ({
      t: Number(c.bucketStart),
      open: Number(c.openPrice) / 1e6,
      high: Number(c.high) / 1e6,
      low: Number(c.low) / 1e6,
      close: Number(c.closePrice) / 1e6,
    }));
  } catch {
    return []; // no fills yet, or indexer hiccup → an empty line, not a thrown route
  }
}
