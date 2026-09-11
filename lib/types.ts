// lib/types.ts — the SHARED CONTRACT between the trading core (lib/, app/api/)
// and the frontend (app/(ui)/). The frontend imports from here and must NOT
// redefine these shapes. Core owns this file. See AGENT.md §3.

/** Which way the user thinks the price will move. UI-facing vocabulary. */
export type Side = "UP" | "DOWN";

/** On-chain market status from getMarketOnchain(). 1 = Trading is the only tradable state. */
export enum MarketStatus {
  Listed = 0,
  Trading = 1,
  Locked = 2,
  Settling = 3,
  Resolved = 4,
  Voided = 5,
}

/** PancakeSwap-style round phase, derived from status + expiry. */
export type RoundPhase = "NEXT" | "LIVE" | "EXPIRED";

/**
 * A live Event Contract market, normalized for the UI.
 * `pool` + `marketId` are the on-chain handles; the UI treats them as opaque strings.
 */
export interface Market {
  marketId: string;
  pool: string;
  asset: string; // e.g. "BTC", "ETH"
  intervalSec: number; // window length, e.g. 900 for 15min
  expiry: number; // unix seconds when the window closes
  status: MarketStatus;
  /** Implied probability of UP, 0..1 (derived from mid price). Null if no book yet. */
  upProbability: number | null;
}

/**
 * A round = a market window, framed PancakeSwap-style for the UI.
 * NEXT = open, you can enter; LIVE = locked and running; EXPIRED = resolved.
 */
export interface Round {
  marketId: string;
  pool: string;
  asset: string;
  intervalSec: number;
  expiry: number;
  phase: RoundPhase;
  status: MarketStatus;
  /** Seconds until expiry (>0) or since expiry (<=0). For the countdown. */
  secondsToExpiry: number;
  /** Implied UP probability 0..1, or null if no book. */
  upProbability: number | null;
  /** Payout multiplier if UP wins, i.e. 1/upPrice. Null if no price. e.g. 2.5 = 2.5x. */
  upPayout: number | null;
  /** Payout multiplier if DOWN wins, i.e. 1/(1-upPrice). Null if no price. */
  downPayout: number | null;
  /** For EXPIRED rounds: which side won (null while unresolved/voided). */
  winner: Side | null;
}

/**
 * Direct on-chain settlement state for ONE market, read via getMarketOnchain and
 * NOT the MarketCreated log scan — so it keeps resolving after a market ages out
 * of the discovery window (which is why Positions couldn't tell a bet had won).
 */
export interface MarketState {
  status: MarketStatus;
  /** Resolved, voided, or finalized — the round is decided and no longer live. */
  settled: boolean;
  /** Market was voided (both sides refund at 0.5) rather than resolved to a winner. */
  voided: boolean;
  /** Winning side once settled to a winner; null while unresolved or voided. */
  winner: Side | null;
}

/** Crowd meter payload — the social read on a market's price. upPct + downPct = 100. */
export interface CrowdMeter {
  upPct: number; // 0..100, rounded for display
  downPct: number; // 0..100
  /** Raw implied UP probability 0..1 before rounding, for bars/animation. */
  raw: number;
}

/** Result of placing a bet (a taker order that crosses the book). */
export interface BetResult {
  ok: boolean;
  txHash?: string;
  /** Contracts actually filled (human units). 0 if nothing crossed. */
  filledQty: number;
  /** Average fill price as probability 0..1. */
  fillPrice: number | null;
  side: Side;
  marketId: string;
  /**
   * Fee rate charged on this bet as a fraction of the fill (e.g. 0.01 = 1%).
   * Absent when the market-fee rail is off (the default). Sway routes this cut
   * on-chain through the protocol's native builder-fee rail — see config.ts.
   */
  feeRate?: number;
  /** Estimated fee paid in collateral (human units), = feeRate × fill notional. Absent when no fee. */
  fee?: number;
  /** Present when ok=false — a friendly, already-decoded message (never a raw revert). */
  error?: string;
}

/** Result of redeeming winning positions after settlement. */
export interface RedeemResult {
  ok: boolean;
  claims: Array<{ marketId: string; asset: string; side: Side; amount: number; txHash: string }>;
  /** Total collateral claimed across all redeemed markets (human units). */
  totalClaimed: number;
  error?: string;
}

/** A live update pushed from stream.ts as the book/price moves. */
export interface MarketUpdate {
  marketId: string;
  upProbability: number | null;
  status: MarketStatus;
  crowd: CrowdMeter;
}

/** One row on the leaderboard. */
export interface LeaderboardEntry {
  wallet: string; // address (lowercased) — identity
  handle?: string; // optional display name
  wins: number;
  losses: number;
  streak: number; // current consecutive wins
  bestStreak: number;
  pnl: number; // net collateral won/lost (human units)
  rank: number; // 1-based, assigned by the API
}

/** Body posted to /api/result when a bet settles. */
export interface ResultReport {
  wallet: string;
  marketId: string;
  side: Side;
  stake: number; // human units risked
  won: boolean;
  payout?: number; // collateral received if won
}

/**
 * Live cash-out quote for an open position — what selling now would return.
 * This is the order-book advantage over a parimutuel pool: you can leave a
 * winning (or losing) guess *before* the round resolves. A one-sided or empty
 * book (nobody bidding on your side) honestly returns `canCashOut: false`.
 */
export interface CashOutQuote {
  marketId: string;
  side: Side;
  /** Outcome tokens the wallet holds on this side (human units). 0 = nothing to sell. */
  heldQty: number;
  /** Best resting bid on the held side as a probability 0..1, or null if no bid exists. */
  bestBid: number | null;
  /** Estimated collateral received cashing out now (human units), walking the bids. */
  estProceeds: number;
  /** True when there is at least one bid to sell into. */
  canCashOut: boolean;
  /** True when the book can't fully absorb the held size (a partial exit). */
  partial: boolean;
}

/** Result of cashing out — selling an open position back to the book as an IOC taker. */
export interface CashOutResult {
  ok: boolean;
  txHash?: string;
  /** Outcome tokens actually sold (human units). 0 if nothing crossed. */
  soldQty: number;
  /** Volume-weighted sale price as a probability 0..1. */
  fillPrice: number | null;
  /** Collateral received (human units). */
  proceeds: number;
  side: Side;
  marketId: string;
  /** Present when ok=false — a friendly, already-decoded message. */
  error?: string;
}

/**
 * One OHLC point of a market's implied-probability series ("Sway the line").
 * The order-book price IS a live, money-weighted probability, so the OHLC of
 * price is the OHLC of the crowd's belief. All four values are UP-probability
 * in 0..1 (already scaled from the raw 1e6 candle prices).
 */
export interface ProbabilityPoint {
  /** Bucket start, unix seconds. */
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
}
