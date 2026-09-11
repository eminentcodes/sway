// lib/somnia/stream.ts — live price/status updates for a market.
//
// The whole point of Somnia here is speed: the card should feel alive. This
// wraps a polling loop over on-chain reads into a subscribe/unsubscribe handle.
// (We poll rather than the SDK's socket watch because reads are unthrottled and
// polling is trivially robust for a 3-day demo; can swap to ex.client watches
// later without changing this signature.)

import { getMarket, impliedUpProbability } from "./markets";
import { getCrowd } from "./crowd";
import { MarketUpdate } from "../types";

const DEFAULT_INTERVAL_MS = 2000;

/**
 * Watch a market for price/status changes. Calls `cb` immediately with the
 * current snapshot, then on each change. Returns an unsubscribe function.
 */
export function watchMarket(
  marketId: string,
  cb: (u: MarketUpdate) => void,
  intervalMs: number = DEFAULT_INTERVAL_MS
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastKey = "";

  const tick = async () => {
    if (stopped) return;
    try {
      const m = await getMarket(marketId);
      const crowd = getCrowd(m);
      const key = `${m.status}:${crowd.upPct}`;
      if (key !== lastKey) {
        lastKey = key;
        cb({ marketId, upProbability: m.upProbability, status: m.status, crowd });
      }
    } catch {
      // transient read failure — keep the loop alive, try again next tick.
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };

  tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

/** One-shot snapshot without subscribing — handy for server routes. */
export async function snapshot(marketId: string): Promise<MarketUpdate> {
  const m = await getMarket(marketId);
  return { marketId, upProbability: m.upProbability, status: m.status, crowd: getCrowd(m) };
}
