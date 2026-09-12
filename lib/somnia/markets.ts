// lib/somnia/markets.ts — discover live markets and check tradability.
//
// Discovery scans `MarketCreated` chain logs directly (indexer-independent, the
// resilient path from SKILL.md). We filter by collateral (tUSDC) because
// MarketCreated carries no venueId; on testnet every live market shares this
// collateral, so that's enough. Verified against the template's discover.mjs.

import { marketCreatedEvent as marketCreated } from "./abi";
import { pub, COLLATERAL, sharedExchange, readExchange } from "./client";
import { Market, MarketStatus } from "../types";

// Somnia caps getLogs at 1000 blocks per call, so walk backwards in windows.
const WINDOW = 1000n;
// How many 1000-block windows back to scan for MarketCreated logs.
//
// This is the wall-clock reach of discovery, and it MUST exceed the longest
// cadence we want to show. Longer series are created far less often (a 1h round
// is minted ~once an hour, a 15m ~every 15m) while 5m/10m rounds roll
// constantly — so on Somnia's sub-second blocks a shallow scan only ever caught
// the freshly-minted short cadences and silently dropped 15m/1h markets whose
// creation log had already scrolled past the window (they rendered as "only 5m
// and 10m markets"). 48k blocks reaches back far enough to catch a live 1h
// market created near the start of its window; expired ones are still filtered
// by `expiry > now` below, and a window that rate-limits just yields nothing for
// that scan (the client keeps unexpired cards mounted across polls regardless).
const LOOKBACK_WINDOWS = 48;

interface RawMarket {
  marketId: string;
  pool: string;
  asset: string;
  intervalSec: number;
  expiry: number;
  collateral: string;
}

// The scanned block ranges are immutable history (only the head grows), so the
// whole scan is safe to cache and even serve stale. The home feed polls every few
// seconds and each poll used to re-run every window; caching turns that poll storm
// into at most one real scan per TTL. We serve STALE-WHILE-REVALIDATE: once warmed,
// a request returns the cached rows instantly and refreshes in the background, so
// the (seconds-long) log scan never blocks a poll again — only the very first cold
// request waits. A brand-new market shows up within one TTL.
let _logsCache: { at: number; rows: RawMarket[] } | null = null;
let _logsRefreshing: Promise<RawMarket[]> | null = null;
const LOGS_TTL_MS = 30_000;

/** The real scan: walk the lookback windows CONCURRENTLY and collect raw args. */
async function runCreatedLogsScan(): Promise<RawMarket[]> {
  const head = await pub.getBlockNumber();

  // Build the window ranges up front, then fetch them CONCURRENTLY instead of one
  // after another. This is the single biggest latency win: the windows are
  // independent, so firing them together collapses N serial RPC round-trips (which
  // dominated the fetch time) into a few parallel batches. Concurrency is capped so
  // we don't trip the RPC's rate limit.
  const ranges: { from: bigint; to: bigint }[] = [];
  for (let i = 0; i < LOOKBACK_WINDOWS; i++) {
    const to = head - BigInt(i) * WINDOW;
    if (to < WINDOW) break;
    ranges.push({ from: to - (WINDOW - 1n), to });
  }

  const found: RawMarket[] = [];
  const CONCURRENCY = 8;
  for (let i = 0; i < ranges.length; i += CONCURRENCY) {
    const batch = ranges.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map((r) =>
        pub
          .getLogs({ event: marketCreated as any, fromBlock: r.from, toBlock: r.to })
          // one bad window (rate limit / reorg) yields nothing, never fails the scan.
          .catch(() => [] as unknown[])
      )
    );
    for (const logs of results) {
      for (const l of logs as any[]) {
        const a: any = (l as any).args;
        found.push({
          marketId: String(a.marketId),
          pool: a.pool,
          asset: a.asset,
          intervalSec: Number(a.intervalSec),
          expiry: Number(a.expiry),
          collateral: a.collateral,
        });
      }
    }
  }
  return found;
}

/** Run (at most one) scan at a time, storing the result in the cache. */
function refreshCreatedLogs(): Promise<RawMarket[]> {
  if (!_logsRefreshing) {
    _logsRefreshing = runCreatedLogsScan()
      .then((rows) => {
        _logsCache = { at: Date.now(), rows };
        return rows;
      })
      .finally(() => {
        _logsRefreshing = null;
      });
  }
  return _logsRefreshing;
}

/**
 * Recent MarketCreated raw args (unfiltered), cached stale-while-revalidate.
 * Fresh cache → instant. Stale cache → return stale now, refresh in background.
 * No cache (cold) → await the first scan.
 */
async function scanCreatedLogs(): Promise<RawMarket[]> {
  if (_logsCache) {
    if (Date.now() - _logsCache.at >= LOGS_TTL_MS) {
      void refreshCreatedLogs().catch(() => {}); // stale: refresh behind the scenes
    }
    return _logsCache.rows; // serve cached (fresh or stale) immediately
  }
  return refreshCreatedLogs(); // cold: nothing cached yet, wait for the first scan
}

/**
 * Live, tradable markets, normalized for the UI and sorted soonest-expiry first.
 * Enriches each with fresh on-chain status + implied UP probability.
 */
export async function discoverMarkets(): Promise<Market[]> {
  const now = Math.floor(Date.now() / 1000);
  const raw = await scanCreatedLogs();

  // De-dupe by marketId, keep unexpired + fundable collateral.
  const seen = new Set<string>();
  const candidates = raw.filter((m) => {
    if (seen.has(m.marketId)) return false;
    seen.add(m.marketId);
    return m.expiry > now && m.collateral?.toLowerCase() === COLLATERAL.toLowerCase();
  });

  const ex = readExchange(); // public reads — no signing key needed
  // Enrich every candidate CONCURRENTLY (each does 1 status read + 2 order-book
  // reads for the implied probability). Serial per-candidate awaits were stacking
  // on top of the log scan; a market that can't be read on-chain drops out.
  const enriched = await Promise.all(
    candidates.map(async (c): Promise<Market | null> => {
      try {
        const [mo, upProbability] = await Promise.all([
          ex.client.getMarketOnchain(c.marketId as `0x${string}`),
          impliedUpProbability(c.pool),
        ]);
        return {
          marketId: c.marketId,
          pool: c.pool,
          asset: c.asset,
          intervalSec: c.intervalSec,
          expiry: c.expiry,
          status: Number(mo.status) as MarketStatus,
          upProbability,
        };
      } catch {
        // couldn't read this one on-chain — skip it rather than show a broken card.
        return null;
      }
    })
  );
  return enriched
    .filter((m): m is Market => m !== null)
    .sort((a, b) => a.expiry - b.expiry);
}

/** One market by id, with fresh on-chain status. Throws if unreadable. */
export async function getMarket(marketId: string): Promise<Market> {
  const ex = readExchange(); // public reads — no signing key needed
  const mo = await ex.client.getMarketOnchain(marketId as `0x${string}`);
  // We need the static fields (asset/pool/interval/expiry) from the created logs.
  const raw = (await scanCreatedLogs()).find((m) => m.marketId === marketId);
  if (!raw) throw new Error(`Market ${marketId} not found in recent MarketCreated logs.`);
  return {
    marketId,
    pool: raw.pool,
    asset: raw.asset,
    intervalSec: raw.intervalSec,
    expiry: raw.expiry,
    status: Number(mo.status) as MarketStatus,
    upProbability: await impliedUpProbability(raw.pool),
  };
}

/**
 * True only when the market is actually open for trading (status === 1).
 * MUST gate every write — an expiry in the future does NOT mean it's tradable.
 *
 * Reads only (no signer needed), so it accepts the SAME optional exchange
 * placeBet() carries: pass the browser-wallet exchange and the gate reads through
 * it instead of the server key. Defaults to the env-key shared exchange (server).
 */
export async function isTradable(
  marketId: string,
  exchange?: ReturnType<typeof sharedExchange>
): Promise<boolean> {
  const ex = exchange ? exchange.ex : readExchange();
  try {
    const mo = await ex.client.getMarketOnchain(marketId as `0x${string}`);
    return !mo.finalized && Number(mo.status) === MarketStatus.Trading;
  } catch {
    return false;
  }
}

/**
 * Implied UP probability (0..1) from the mid of the best bid/ask, or null if the
 * book is empty. Down price is always 1 - Up, so the Up book alone defines it.
 */
export async function impliedUpProbability(pool: string): Promise<number | null> {
  const ex = readExchange(); // public reads — no signing key needed
  try {
    const [bids, asks] = await Promise.all([
      ex.client.getAllOpenOrdersOnchain(pool as `0x${string}`, { isBid: true }),
      ex.client.getAllOpenOrdersOnchain(pool as `0x${string}`, { isBid: false }),
    ]);
    const bestBid = Math.max(0, ...((bids.orders || []).map((o: any) => Number(o.price))));
    const askPrices = (asks.orders || []).map((o: any) => Number(o.price)).filter((p: number) => p > 0);
    const bestAsk = askPrices.length ? Math.min(...askPrices) : 0;

    if (bestBid && bestAsk) return (bestBid + bestAsk) / 2 / 1e6;
    if (bestBid) return bestBid / 1e6;
    if (bestAsk) return bestAsk / 1e6;
    return null;
  } catch {
    return null;
  }
}
