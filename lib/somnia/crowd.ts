// lib/somnia/crowd.ts — the "crowd meter" social read.
//
// An Event Contract's price IS the crowd's implied probability. We turn that into
// a display-ready split. Pure functions, no I/O — cheap to call from anywhere.

import { CrowdMeter, Market } from "../types";

/** Convert a market's implied UP probability into a crowd-meter split. */
export function getCrowd(market: Pick<Market, "upProbability">): CrowdMeter {
  const raw = market.upProbability;
  // No book yet → show an even, honest 50/50 rather than faking confidence.
  if (raw == null || Number.isNaN(raw)) {
    return { upPct: 50, downPct: 50, raw: 0.5 };
  }
  const clamped = Math.min(1, Math.max(0, raw));
  const upPct = Math.round(clamped * 100);
  return { upPct, downPct: 100 - upPct, raw: clamped };
}

/** Probability (0..1) → SDK price units (1e6). Mirrors probabilityToPrice. */
export function probToPrice(prob: number): bigint {
  const clamped = Math.min(0.99, Math.max(0.01, prob));
  return BigInt(Math.round(clamped * 1_000_000));
}

/** SDK price units (1e6) → probability (0..1). */
export function priceToProb(price: number | bigint): number {
  return Number(price) / 1_000_000;
}
