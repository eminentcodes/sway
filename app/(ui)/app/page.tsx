"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { AlertCircle, ArrowDown, ArrowUp, BriefcaseBusiness, Copy, House, Loader2, Lock, LogOut, Trophy, Wallet, X } from "lucide-react";
import { useAccount, useConnect, useDisconnect, useReadContract } from "wagmi";
import { getAccount, getWalletClient, switchChain } from "wagmi/actions";
import { wagmiConfig } from "../../../lib/somnia/wagmi";
import { bindWallet } from "../../../lib/somnia/browser";
import {
  placeBet as placeBetBrowser,
  sellPosition as sellPositionBrowser,
  redeemWinnings as redeemBrowser,
} from "../../../lib/somnia/trade-browser";
import { CHAIN_ID, COLLATERAL } from "../../../lib/somnia/config";
import type { BetResult, CashOutQuote, CashOutResult, LeaderboardEntry, RedeemResult, Round, Side } from "../../../lib/types";

type Tab = "home" | "positions" | "leaderboard";
type Metric = "streak" | "winrate" | "pnl";

const short = (wallet: string) => `${wallet.slice(0, 6)}...${wallet.slice(-4)}`;

/** mm:ss from a raw seconds count. */
function formatTime(seconds: number) {
  const value = Math.max(0, Math.floor(seconds));
  return `${Math.floor(value / 60).toString().padStart(2, "0")}:${(value % 60).toString().padStart(2, "0")}`;
}
function formatInterval(seconds: number) {
  if (!seconds || seconds <= 0) return "live round";
  if (seconds >= 3600 && seconds % 3600 === 0) return `${seconds / 3600}-hour`;
  // Event-contract windows include a small scheduling buffer around the
  // advertised cadence (for example 330s represents the 5-minute round).
  // Snap minute labels to the nearest 5-minute cadence instead of showing 6/16.
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes >= 5) return `${Math.max(5, Math.round(minutes / 5) * 5)}-minute`;
  return `${minutes}-minute`;
}
function formatCardInterval(seconds: number) {
  if (!seconds || seconds <= 0) return "live round";
  if (seconds >= 3600) return `${Math.max(1, Math.round(seconds / 3600))} hr round`;
  const mins = Math.max(1, Math.round(seconds / 60 / 5) * 5);
  return `${mins} mins round`;
}

/** Turn a wagmi/viem/EIP-1193 wallet failure into an honest line — never a blanket "cancelled". */
function walletErrorMessage(e: unknown): string {
  const err = e as { name?: string; code?: number; shortMessage?: string; message?: string; cause?: { code?: number; name?: string } };
  const code = err?.code ?? err?.cause?.code;
  const name = err?.name ?? err?.cause?.name;
  if (code === 4001 || name === "UserRejectedRequestError") return "You dismissed the request in your wallet. Tap again when you're ready.";
  if (code === -32002) return "Your wallet already has a request open — approve or dismiss it there, then try again.";
  if (/chain mismatch|wrong network|unsupported chain|ChainMismatch|4902/i.test(`${name} ${err?.message}`)) return "Add or switch to Somnia Shannon (chain 50312) in your wallet, then try again.";
  return err?.shortMessage || err?.message || "Couldn't reach your wallet. Make sure it's unlocked and on Somnia Shannon, then try again.";
}

/** Reject after `ms` with `message` if `p` hasn't settled — so a stalled wallet/receipt never spins forever. */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); }
    );
  });
}

/**
 * Fold a fresh /api/rounds poll into the on-screen list WITHOUT wholesale
 * replacement — swapping the whole array is what made live cards blink out when
 * a single poll returned a smaller or reordered subset (an RPC hiccup, a cache
 * refresh mid-scan, or a market rotating). The incoming poll is the source of
 * truth for every market it names; a market it *omits* is kept only until its
 * own expiry (plus a little grace), so a momentary drop can't unmount a still-
 * live card, yet genuinely-ended markets still fall off. The result is sorted
 * deterministically so each market holds a stable slot poll-to-poll (no reflow).
 */
function mergeRounds(prev: Round[], next: Round[], nowMs: number): Round[] {
  const GRACE_MS = 5_000;
  const merged = new Map<string, Round>(next.map((round) => [round.marketId, round]));
  for (const round of prev) {
    if (!merged.has(round.marketId) && round.expiry * 1000 + GRACE_MS > nowMs) {
      merged.set(round.marketId, round); // a still-live market this poll skipped — hold it
    }
  }
  // Mirror the server's ordering (enterable first) but make it fully deterministic
  // so a given market keeps its slot poll-to-poll: phase, then fastest cadence,
  // then soonest expiry, then id as the final tie-break.
  const phaseRank: Record<Round["phase"], number> = { NEXT: 0, LIVE: 1, EXPIRED: 2 };
  return Array.from(merged.values()).sort(
    (a, b) =>
      phaseRank[a.phase] - phaseRank[b.phase] ||
      a.intervalSec - b.intervalSec ||
      a.expiry - b.expiry ||
      a.marketId.localeCompare(b.marketId)
  );
}

// ── Local position ledger ────────────────────────────────────────────────────
// Path A bets are signed by the visitor's wallet, so the outcome tokens live at
// THEIR address. We remember what they bet (per wallet, in localStorage) so the
// Positions tab can show open calls, quote live cash-out value, and drive redeem
// after settlement. Live value + settlement come from the read APIs; this is just
// the "what did I bet on" index the chain doesn't hand back by market.
type BetRecord = {
  marketId: string;
  pool: string;
  asset: string;
  side: Side;
  stake: number; // human units entered
  filledQty: number; // contracts filled (human units)
  fillPrice: number | null;
  txHash?: string;
  at: number; // ms timestamp
  expiry?: number; // round expiry (unix seconds) — lets Positions show a countdown without re-fetching the round
  done?: boolean; // redeemed / cashed out / loss recorded — leaves the open list
  won?: boolean; // set once settled
};

const betsKey = (wallet: string) => `sway.bets.${wallet.toLowerCase()}`;

function loadBets(wallet: string): BetRecord[] {
  if (!wallet) return [];
  try {
    const raw = localStorage.getItem(betsKey(wallet));
    return raw ? (JSON.parse(raw) as BetRecord[]) : [];
  } catch {
    return [];
  }
}
function saveBets(wallet: string, list: BetRecord[]) {
  try {
    localStorage.setItem(betsKey(wallet), JSON.stringify(list));
  } catch {
    /* private mode / quota — the tab still works, just without memory. */
  }
}
/** Add a bet, merging into an existing open call on the same market+side. */
function recordBet(wallet: string, rec: BetRecord) {
  const list = loadBets(wallet);
  const i = list.findIndex((b) => b.marketId === rec.marketId && b.side === rec.side && !b.done);
  if (i >= 0) {
    list[i] = {
      ...list[i],
      stake: list[i].stake + rec.stake,
      filledQty: list[i].filledQty + rec.filledQty,
      fillPrice: rec.fillPrice ?? list[i].fillPrice,
      txHash: rec.txHash || list[i].txHash,
      expiry: rec.expiry ?? list[i].expiry,
      at: rec.at,
    };
  } else {
    list.unshift(rec);
  }
  saveBets(wallet, list);
  window.dispatchEvent(new Event("sway:positions-changed"));
}
function patchBet(wallet: string, marketId: string, side: Side, patch: Partial<BetRecord>) {
  saveBets(
    wallet,
    loadBets(wallet).map((b) => (b.marketId === marketId && b.side === side ? { ...b, ...patch } : b))
  );
  window.dispatchEvent(new Event("sway:positions-changed"));
}

export default function AppHome() {
  const pathname = usePathname();
  const tab: Tab = pathname.endsWith("/positions") ? "positions" : pathname.endsWith("/leaderboard") ? "leaderboard" : "home";

  const [rounds, setRounds] = useState<Round[]>(() => { if (typeof window === "undefined") return []; try { return JSON.parse(sessionStorage.getItem("sway.live-rounds") || "[]") as Round[]; } catch { return []; } });
  const [leaders, setLeaders] = useState<LeaderboardEntry[]>([]);
  const [me, setMe] = useState<LeaderboardEntry | null>(null);
  const [loading, setLoading] = useState(false);
  const [feedError, setFeedError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [trade, setTrade] = useState<{ round: Round; side: Side } | null>(null);
  const [walletOpen, setWalletOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [metric, setMetric] = useState<Metric>("streak");
  const [activePositionCount, setActivePositionCount] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [bannerSlide, setBannerSlide] = useState(0);
  const [intervalFilter, setIntervalFilter] = useState<number | "all">("all");
  const [mounted, setMounted] = useState(false);
  const lastFeed = useRef("");
  const feedRef = useRef<Round[]>(rounds); // latest merged feed, read by the poller without a stale closure

  const { address, isConnected, status, chainId } = useAccount();
  const { connectAsync, connectors, isPending: connecting } = useConnect();
  const { disconnect } = useDisconnect();
  const router = useRouter();
  const wrongChain = mounted && isConnected && chainId !== CHAIN_ID;
  // While wagmi restores a stored session (e.g. after a hard refresh) the account
  // is briefly neither connected nor disconnected. Treat that as "still linking"
  // so the UI never flashes "Connect wallet" over an already-connected visitor.
  const reconnecting = mounted && !isConnected && (status === "reconnecting" || status === "connecting");

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!address) { setActivePositionCount(0); return; }
    const sync = () => { try { const items = JSON.parse(localStorage.getItem(betsKey(address)) || "[]") as BetRecord[]; setActivePositionCount(items.filter((item) => !item.done).length); } catch { setActivePositionCount(0); } };
    sync();
    window.addEventListener("focus", sync);
    window.addEventListener("sway:positions-changed", sync);
    return () => { window.removeEventListener("focus", sync); window.removeEventListener("sway:positions-changed", sync); };
  }, [address]);

  // ── Wallet helpers ─────────────────────────────────────────────────────────
  const doConnect = useCallback(async (selected?: (typeof connectors)[number]): Promise<{ ok: boolean; error?: string }> => {
    // Already linked (opened /app directly with a connected wallet, or a second tap) — done.
    if (isConnected) { setWalletOpen(false); return { ok: true }; }
    // The modal may hand us its "Browser wallet" placeholder (no `.type`) when
    // no real connector was discovered — fall through to the discovered ones.
    const chosen = selected && (selected as { type?: string }).type ? selected : undefined;
    const connector = chosen ?? connectors.find((c) => c.type === "injected") ?? connectors[0];
    if (!connector) return { ok: false, error: "No wallet detected. Install MetaMask or Rabby, then reload the page." };
    try {
      // Time-box the request: when two wallets are installed, a non-default one
      // (often MetaMask, when Rabby owns window.ethereum) can never surface its
      // popup — connectAsync then hangs forever and the button just spins. A
      // timeout turns that dead-end into an actionable message.
      const result = await withTimeout(connectAsync({ connector }), 60000, "TIMEOUT_CONNECT");
      if (!result.accounts?.length) {
        return { ok: false, error: "Your wallet connected but shared no account. Open it, pick an account for this site, then try again." };
      }
      setWalletOpen(false);
      return { ok: true };
    } catch (e) {
      // wagmi throws this when the connector is already connected — treat as success.
      if ((e as { name?: string }).name === "ConnectorAlreadyConnectedError") { setWalletOpen(false); return { ok: true }; }
      if (e instanceof Error && e.message === "TIMEOUT_CONNECT") {
        return { ok: false, error: `${connector.name || "Your wallet"} didn't respond. If it's installed next to another wallet, open its extension and approve the connection there, then try again.` };
      }
      // Surface the REAL reason (rejected, request already open, wrong network)
      // instead of swallowing it — a silent `false` reads as "nothing happened".
      return { ok: false, error: walletErrorMessage(e) };
    }
  }, [connectAsync, connectors, isConnected]);

  /** Ensure connected + on Somnia, then bind the wallet into an SDK exchange. */
  const getBound = useCallback(async () => {
    const acct = getAccount(wagmiConfig);
    if (!acct.isConnected || !acct.address) throw new Error("Connect a wallet before placing your call.");
    if (acct.chainId !== CHAIN_ID) {
      // A wallet that's adding Somnia for the first time can leave this pending
      // with no response — bound it so the bet fails loud instead of spinning.
      try {
        await withTimeout(switchChain(wagmiConfig, { chainId: CHAIN_ID }), 45000, "TIMEOUT_SWITCH");
      } catch (e) {
        if (e instanceof Error && e.message === "TIMEOUT_SWITCH") {
          throw new Error("Your wallet didn't finish switching to Somnia Shannon. Open it, approve the network, then try again.");
        }
        throw new Error(walletErrorMessage(e));
      }
    }
    // Pass the active account explicitly. Rabby can expose multiple injected
    // accounts; omitting this lets viem build a client for the wrong one and
    // causes approval/sign requests to be rejected or silently not appear.
    const walletClient = await getWalletClient(wagmiConfig, { account: acct.address, chainId: CHAIN_ID });
    if (!walletClient) throw new Error("Couldn't reach your wallet. Reconnect and try again.");
    return bindWallet(walletClient);
  }, []);

  const switchToChain = useCallback(async () => {
    try {
      await switchChain(wagmiConfig, { chainId: CHAIN_ID });
    } catch {
      /* user declined — the bet flow will prompt again when they act. */
    }
  }, []);

  // ── Path A actions ───────────────────────────────────────────────────────────
  const placeCall = useCallback(
    async (round: Round, side: Side, amountUsd: number): Promise<BetResult> => {
      const bound = await getBound();
      const result = await placeBetBrowser({ marketId: round.marketId, pool: round.pool, side, amountUsd }, bound);
      if (!result.ok) throw new Error(result.error || "The call could not be placed.");
      recordBet(bound.address, {
        marketId: round.marketId,
        pool: round.pool,
        asset: round.asset,
        side,
        stake: amountUsd,
        filledQty: result.filledQty,
        fillPrice: result.fillPrice,
        txHash: result.txHash,
        expiry: round.expiry,
        at: Date.now(),
      });
      return result;
    },
    [getBound]
  );

  const cashOutPos = useCallback(
    async (rec: BetRecord): Promise<CashOutResult> => {
      const bound = await getBound();
      const result = await sellPositionBrowser({ marketId: rec.marketId, pool: rec.pool, side: rec.side }, bound);
      if (!result.ok) throw new Error(result.error || "Cash out failed.");
      const remainingQty = Math.max(0, rec.filledQty - result.soldQty);
      patchBet(bound.address, rec.marketId, rec.side, { done: remainingQty < 0.000001, filledQty: remainingQty });
      return result;
    },
    [getBound]
  );

  const redeemPos = useCallback(
    async (rec: BetRecord, won: boolean): Promise<RedeemResult> => {
      const bound = await getBound();
      const result = await redeemBrowser([rec.marketId], bound);
      if (!result.ok) throw new Error(result.error || "Redeem failed."); // keep it redeemable + surface why, like cash out
      // Record the settled result on the leaderboard (idempotent server-side).
      try {
        await fetch("/api/result", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ wallet: bound.address, marketId: rec.marketId, side: rec.side, stake: rec.stake, won, payout: result.totalClaimed }),
        });
      } catch {
        /* leaderboard write is best-effort; the redeem itself already succeeded. */
      }
      patchBet(bound.address, rec.marketId, rec.side, { done: true, won });
      return result;
    },
    [getBound]
  );

  // ── Feed: rounds + leaderboard ───────────────────────────────────────────────
  // Two independent pollers. The rounds poller is the delicate one: it must never
  // (a) stack requests when the RPC is slow, or (b) blank out good markets because
  // one poll hiccuped. So it is guarded against overlap and only ever *adds* fresh
  // data — a failed poll keeps the last good rounds on screen, and the render below
  // decides whether "unavailable" is warranted (only when there is truly nothing).
  useEffect(() => {
    let active = true;
    let inFlight = false;

    const loadRounds = async () => {
      if (inFlight) return; // a slow RPC must not pile up overlapping polls — that was the flicker
      inFlight = true;
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 7000);
      try {
        const response = await fetch("/api/rounds", { signal: controller.signal });
        const payload = await response.json().catch(() => ({}));
        const nextRounds: Round[] = payload.rounds || [];
        if (!active) return;
        if (response.ok || nextRounds.length) {
          // Never replace a populated snapshot with a transient empty response.
          // Keeping the same market IDs mounted prevents card flicker/unmounts;
          // subsequent successful polls update the values in place.
          if (nextRounds.length > 0) {
            // Merge, don't replace: a poll returning a smaller/reordered subset
            // must update values in place and keep still-live cards mounted,
            // never blank them. See mergeRounds.
            const merged = mergeRounds(feedRef.current, nextRounds, Date.now());
            const snapshot = JSON.stringify(merged);
            if (snapshot !== lastFeed.current) {
              lastFeed.current = snapshot;
              feedRef.current = merged;
              setRounds(merged); try { sessionStorage.setItem("sway.live-rounds", snapshot); } catch { /* storage unavailable */ }
            }
          }
          setFeedError(false);
        } else {
          // Hard failure with nothing to show. The render only surfaces this when we
          // have zero rounds, so any markets already on screen are left untouched.
          setFeedError(true);
        }
      } catch {
        if (active) setFeedError(true); // network/abort — kept harmless by the render guard when we have data
      } finally {
        window.clearTimeout(timeout);
        if (active) setLoading(false);
        inFlight = false;
      }
    };

    const loadLeaders = async () => {
      try {
        const response = await fetch(`/api/leaderboard${address ? `?wallet=${address}` : ""}`);
        const payload = await response.json();
        if (!active) return;
        setLeaders(payload.entries || []);
        setMe(payload.me || null);
      } catch {
        /* leaderboard is best-effort — it must never block or disturb the market feed */
      }
    };

    loadRounds();
    loadLeaders();
    const timer = window.setInterval(() => {
      loadRounds();
      loadLeaders();
    }, 3000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [retry, address]);

  // ── 1s countdown ticker ──────────────────────────────────────────────────────
  useEffect(() => {
    const clock = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(clock);
  }, []);

  useEffect(() => {
    if (tab !== "home") return;
    const timer = window.setInterval(() => setBannerSlide((slide) => (slide + 1) % 3), 5000);
    return () => window.clearInterval(timer);
  }, [tab]);

  const nav = (
    <nav className="side-nav">
      {(["home", "positions", "leaderboard"] as Tab[]).map((item) => {
        const Icon = item === "home" ? House : item === "positions" ? BriefcaseBusiness : Trophy;
        return (
          <Link className={tab === item ? "selected" : ""} key={item} href={item === "home" ? "/app" : `/app/${item}`}>
            <Icon className="nav-glyph" size={17} />
            <span>{item === "home" ? "Home" : item === "positions" ? "Positions" : "Leaderboard"}</span>{item === "positions" && activePositionCount > 0 && <b className="nav-count">{activePositionCount}</b>}
          </Link>
        );
      })}
    </nav>
  );

  const marketCard = (round: Round) => {
    const up = round.upProbability == null ? 50 : Math.round(round.upProbability * 100);
    const secs = round.expiry - now / 1000;
    const enterable = round.phase === "NEXT" && secs > 0;
    return (
      <article className="market-panel market-card" key={round.marketId}>
        <div className="panel-top">
          <div>
            <div className="eyebrow">
              {round.asset} / USD <span className="round-duration">· {round.intervalSec ? formatCardInterval(round.intervalSec) : "live round"}</span>
            </div>
            <h2>Will {round.asset} go up or down?</h2>
          </div>
          {round.phase !== "NEXT" && <span className="live-badge">{round.phase}</span>}
        </div>
        <div className="price-orb">
          <div className="orb-grid" />
          <strong>{up}%</strong>
          <span>{up >= 50 ? "Crowd leaning UP" : "Crowd leaning DOWN"}</span>
          <div className="crowd-meter"><span style={{ width: `${up}%` }} /><b>{up}% UP</b><b>{100 - up}% DOWN</b></div>
        </div>
        <div className="market-stats">
          <div>
            <span>Time left</span>
            <strong className="time-strong">{secs > 0 ? formatTime(secs) : "Locked"}</strong>
          </div>
          <div>
            <span>UP payout</span>
            <strong>{round.upPayout ? `${round.upPayout}x` : "--"}</strong>
          </div>
          <div>
            <span>DOWN payout</span>
            <strong>{round.downPayout ? `${round.downPayout}x` : "--"}</strong>
          </div>
        </div>
        <div className="bet-actions">
          <button className="up-action" disabled={!enterable} onClick={() => enterable && setTrade({ round, side: "UP" })}>
            {enterable ? <ArrowUp size={17} strokeWidth={2.2} /> : <Lock size={16} />}
            {enterable ? "UP" : "Locked"}
          </button>
          <button className="down-action" disabled={!enterable} onClick={() => enterable && setTrade({ round, side: "DOWN" })}>
            {enterable ? <ArrowDown size={17} strokeWidth={2.2} /> : <Lock size={16} />}
            {enterable ? "DOWN" : "Locked"}
          </button>
        </div>
        {!enterable && <p className="card-note">{round.phase === "EXPIRED" ? "This round has settled." : "Locked — running now. Wait for the next round."}</p>}
      </article>
    );
  };

  const preferred = ["BTC", "ETH"]
    .map((asset) => rounds.find((round) => round.asset.toUpperCase().includes(asset)))
    .filter((round): round is Round => Boolean(round));
  const liveRounds = [...preferred, ...rounds.filter((round) => !preferred.some((selected) => selected.marketId === round.marketId))];
  const intervals = Array.from(new Set(liveRounds.map((round) => round.intervalSec).filter((value) => value > 0))).sort((a, b) => a - b);
  // If the chosen duration has aged out of the feed, display "all" instead of an
  // empty grid — without discarding the choice, so it re-applies the moment that
  // duration returns.
  const effectiveFilter = intervalFilter !== "all" && !intervals.includes(intervalFilter) ? "all" : intervalFilter;
  const filteredRounds = effectiveFilter === "all" ? liveRounds : liveRounds.filter((round) => round.intervalSec === effectiveFilter);

  const loadingState = (
    <div className="loading-overlay" aria-label="Loading markets">
      <div className="state-spinner">
        <span className="logo-mark">
          <span />
        </span>
      </div>
    </div>
  );
  const errorState = (
    <div className="state-panel">
      <div className="state-icon">!</div>
      <h2>Markets unavailable</h2>
      <p>The live feed could not be reached right now.</p>
      <button
        className="up-action"
        onClick={() => {
          setLoading(true);
          setFeedError(false);
          setRetry((value) => value + 1);
        }}
      >
        Try again
      </button>
    </div>
  );
  const emptyState = (
    <div className="state-panel">
      <div className="state-icon">◔</div>
      <h2>No open rounds right now</h2>
      <p>New BTC and ETH rounds open continuously. Hang tight — the next one will appear here.</p>
    </div>
  );

  return (
    <main className="app-page">
      <header className="app-header">
        <Link className="brand app-brand" href="/">
          <span className="logo-mark">
            <span />
          </span>
          <span>sway</span>
        </Link>
        <div className="app-header-nav">{nav}</div>
        <button
          className="connect-btn"
          title={mounted && isConnected ? "Disconnect wallet" : "Connect a wallet"}
          onClick={() => (mounted && isConnected ? setAccountOpen(true) : reconnecting ? undefined : setWalletOpen(true))}
        >
          {mounted && isConnected && address ? short(address) : reconnecting ? "Reconnecting…" : "Connect wallet"}
        </button>
      </header>

      {wrongChain && (
        <div className="chain-warning" role="alert">
          <span>You're on the wrong network. Sway runs on Somnia Shannon testnet.</span>
          <button className="lime-btn" onClick={switchToChain}>
            Switch network
          </button>
        </div>
      )}

      <section className="app-content">
        {tab === "home" && <>
          <EducationBanner slide={bannerSlide} onSlide={setBannerSlide} />
          {feedError && liveRounds.length === 0 ? errorState : liveRounds.length > 0 ? <><div className="market-toolbar"><span>Live markets</span><div className="interval-filter" role="group" aria-label="Filter by round duration"><button className={effectiveFilter === "all" ? "active" : ""} onClick={() => setIntervalFilter("all")}>All</button>{intervals.map((interval) => <button key={interval} className={effectiveFilter === interval ? "active" : ""} onClick={() => setIntervalFilter(interval)}>{interval >= 3600 ? `${interval / 3600}h` : `${Math.round(interval / 60)}m`}</button>)}</div></div><div className="markets-grid">{filteredRounds.length ? filteredRounds.map(marketCard) : <div className="state-panel"><h2>No rounds in this interval</h2><p>Choose another duration to see the available live markets.</p></div>}</div></> : emptyState}
        </>}

        {tab === "positions" && (
          <PositionsPanel
            wallet={mounted && isConnected && address ? address : ""}
            reconnecting={false}
            now={now}
            onConnect={() => setWalletOpen(true)}
            onCashOut={cashOutPos}
            onRedeem={redeemPos}
          />
        )}

        {tab === "leaderboard" && <LeaderboardPanel leaders={leaders} me={me} metric={metric} setMetric={setMetric} myWallet={mounted && address ? address : ""} />}
      </section>

      {trade && <TradeModal trade={trade} place={placeCall} onClose={() => setTrade(null)} />}
      {walletOpen && <AppWalletModal connectors={connectors} connecting={connecting} onClose={() => setWalletOpen(false)} onConnect={doConnect} />}
      {accountOpen && address && <AccountModal address={address} onClose={() => setAccountOpen(false)} onDisconnect={() => { disconnect(); setAccountOpen(false); router.push("/"); }} />}
    </main>
  );
}

// ── Trade modal (Path A) ───────────────────────────────────────────────────────
function EducationBanner({ slide, onSlide }: { slide: number; onSlide: (value: number) => void }) { const slides = [["Start with the crowd", "See the live UP probability before you choose a side."], ["Your odds lock at entry", "The payout shown when your order fills is yours for the round."], ["Every round has an ending", "When the timer hits zero, the market resolves and winners can redeem."]]; return <div className="education-banner"><div className="education-copy"><span className="education-index">0{slide + 1} / 03</span><h2>{slides[slide][0]}</h2><p>{slides[slide][1]}</p></div><div className="education-dots">{slides.map((_, index) => <button key={index} className={index === slide ? "active" : ""} onClick={() => onSlide(index)} aria-label={`Show slide ${index + 1}`} />)}</div></div>; }

function TradeModal({
  trade,
  place,
  onClose,
}: {
  trade: { round: Round; side: Side };
  place: (round: Round, side: Side, amountUsd: number) => Promise<BetResult>;
  onClose: () => void;
}) {
  const [stake, setStake] = useState("");
  const [status, setStatus] = useState<"idle" | "pending" | "success" | "error">("idle");
  const [message, setMessage] = useState("");
  const [txHash, setTxHash] = useState<string | undefined>();
  const valid = Number(stake) > 0;
  const multiplier = trade.side === "UP" ? trade.round.upPayout : trade.round.downPayout;
  const potential = multiplier && valid ? Number(stake) * multiplier : 0;

  const submit = async () => {
    if (!valid || status === "pending") return;
    setStatus("pending");
    setMessage("");
    try {
      // Somnia confirms in ~1s once signed; the only long leg is the human
      // approving (possibly a tUSDC approval AND the order). Cap it so a stalled
      // wallet or receipt-wait surfaces instead of spinning "Placing bet…" forever.
      const result = await withTimeout(place(trade.round, trade.side, Number(stake)), 120000, "TIMEOUT_PLACE");
      setStatus("success");
      setTxHash(result.txHash);
      setMessage(result.txHash ? `Confirmed on-chain: ${result.txHash.slice(0, 10)}…` : "Your bet was placed.");
    } catch (error) {
      setStatus("error");
      const msg = error instanceof Error ? error.message : "";
      setMessage(
        msg === "TIMEOUT_PLACE"
          ? "This is taking longer than expected. If you approved the request in your wallet, the position may still land — check the Positions tab or the explorer before retrying."
          : msg || "The call could not be placed."
      );
    }
  };

  return (
    <div
      className="wallet-overlay trade-overlay"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target && status !== "pending") onClose();
      }}
    >
      <section className="wallet-modal trade-modal" role="dialog" aria-modal="true">
        <button className="wallet-close" onClick={onClose} aria-label="Close trade dialog" disabled={status === "pending"}>
          ×
        </button>
        <div className="eyebrow">
          {trade.round.asset} / USD · {trade.side}
        </div>
        <h2>{status === "success" ? "Bet placed." : "How much do you want to stake?"}</h2>
        <p>{status === "success" ? message : "Enter an amount in test USDC. Your potential payout is shown before you confirm."}</p>
        {status !== "success" && (
          <>
            <label className="stake-field">
              <span>Stake</span>
              <div>
                <input
                  autoFocus
                  inputMode="decimal"
                  value={stake}
                  onChange={(event) => setStake(event.target.value.replace(/[^0-9.]/g, ""))}
                  placeholder="0.00"
                />
                <b>tUSDC</b>
              </div>
            </label>
            <div className="potential-payout"><span>Potential payout</span><strong>{potential > 0 ? `${potential.toFixed(2)} tUSDC` : "Enter a stake"}</strong></div>
            <button className="lime-btn trade-confirm" disabled={!valid || status === "pending"} onClick={submit}>
              {status === "pending" ? "Placing bet..." : `Place ${trade.side} bet`} <span>→</span>
            </button>
            {status === "error" && (
              <p className="wallet-error" role="alert">
                {message}
              </p>
            )}
          </>
        )}
        {status === "success" && (
          <div className="trade-success-actions">
            {txHash && <a className="text-link" href={`https://shannon-explorer.somnia.network/tx/${txHash}`} target="_blank" rel="noreferrer">View transaction ↗</a>}
            <button className="lime-btn trade-confirm" onClick={onClose}>Done</button>
          </div>
        )}
      </section>
    </div>
  );
}

// ── Wallet connect modal ───────────────────────────────────────────────────────
function AppWalletModal({ connectors, connecting, onClose, onConnect }: { connectors: readonly any[]; connecting: boolean; onClose: () => void; onConnect: (connector: any) => Promise<{ ok: boolean; error?: string }> }) {
  const [error, setError] = useState("");
  const connect = async (connector: any) => {
    setError("");
    try {
      const res = await onConnect(connector);
      if (!res.ok) setError(res.error || "Couldn't connect. Try again when you're ready.");
    } catch (e) {
      setError(walletErrorMessage(e));
    }
  };
  return (
    <div className="wallet-overlay" onMouseDown={(event) => { if (event.currentTarget === event.target && !connecting) onClose(); }}>
      <section className="wallet-modal wallet-connect-modal" role="dialog" aria-modal="true" aria-labelledby="wallet-title">
        <button className="wallet-close" onClick={onClose} aria-label="Close wallet dialog" disabled={connecting}><X size={18} /></button>
        <div className="wallet-heading"><span className="wallet-heading-icon"><Wallet size={20} /></span><div><div className="eyebrow">Sway account</div><h2 id="wallet-title">Connect wallet</h2></div></div>
        <p className="wallet-subtitle">Connect to place calls and manage positions.</p>
        {(connectors.length ? connectors : [{ uid: "fallback", name: "Browser wallet" }]).filter((c, i, list) => list.findIndex((x) => x.uid === c.uid) === i).map((connector) => <button key={connector.uid} className="wallet-option" onClick={() => connect(connector)} disabled={connecting}><span className="wallet-icon"><Wallet size={20} /></span><span><b>{connector.name}</b><small>Connect securely</small></span><strong>{connecting ? <Loader2 className="spin-icon" size={18} /> : "→"}</strong></button>)}
        <div className="wallet-network"><span className="network-dot" /> Somnia Shannon <span>·</span> Testnet</div>
        {error && <div className="wallet-error" role="alert"><AlertCircle size={16} /><span>{error}</span></div>}
      </section>
    </div>
  );
}

function AccountModal({ address, onClose, onDisconnect }: { address: string; onClose: () => void; onDisconnect: () => void }) {
  const { data: tokenBalance, isLoading } = useReadContract({ address: COLLATERAL, abi: [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] }] as const, functionName: "balanceOf", args: [address as `0x${string}`], chainId: CHAIN_ID });
  const copy = () => navigator.clipboard?.writeText(address);
  return <div className="wallet-overlay" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}><section className="wallet-modal account-modal" role="dialog" aria-modal="true" aria-labelledby="account-title"><button className="wallet-close" onClick={onClose} aria-label="Close account dialog"><X size={18} /></button><div className="wallet-heading"><span className="wallet-heading-icon"><Wallet size={20} /></span><div><div className="eyebrow">Connected wallet</div><h2 id="account-title">Your account</h2></div></div><div className="account-address"><span>{short(address)}</span><button onClick={copy} aria-label="Copy wallet address" title="Copy address"><Copy size={15} /></button></div><div className="account-balance"><span>Balance</span><strong>{isLoading ? "Loading..." : `${(Number(tokenBalance || 0n) / 1_000_000).toFixed(2)} tUSDC`}</strong></div><button className="disconnect-action" onClick={onDisconnect}><LogOut size={16} /> Disconnect wallet</button></section></div>;
}
// ── Positions ────────────────────────────────────────────────────────────────
type PositionView = { round?: Round; quote?: CashOutQuote };

function PositionsPanel({
  wallet,
  reconnecting,
  now,
  onConnect,
  onCashOut,
  onRedeem,
}: {
  wallet: string;
  reconnecting: boolean;
  now: number;
  onConnect: () => void;
  onCashOut: (rec: BetRecord) => Promise<CashOutResult>;
  onRedeem: (rec: BetRecord, won: boolean) => Promise<RedeemResult>;
}) {
  const [records, setRecords] = useState<BetRecord[]>([]);
  const [views, setViews] = useState<Record<string, PositionView>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const reportedLoss = useRef<Set<string>>(new Set());

  const key = (r: BetRecord) => `${r.marketId}:${r.side}`;
  const refresh = useCallback(() => setRecords(loadBets(wallet)), [wallet]);

  useEffect(() => {
    refresh();
  }, [wallet, refresh]);

  // Enrich each tracked bet with a fresh round (settlement) + cash-out quote.
  useEffect(() => {
    if (!wallet || records.length === 0) {
      setViews({});
      return;
    }
    let active = true;
    const run = async () => {
      const pairs = await Promise.all(
        records.map(async (r) => {
          const [roundRes, posRes] = await Promise.allSettled([
            fetch(`/api/rounds/${r.marketId}`).then((x) => x.json()),
            fetch(`/api/position/${r.marketId}?pool=${r.pool}&side=${r.side}&account=${wallet}`).then((x) => x.json()),
          ]);
          const round = roundRes.status === "fulfilled" ? (roundRes.value.round as Round | undefined) : undefined;
          const quote = posRes.status === "fulfilled" ? (posRes.value.quote as CashOutQuote | undefined) : undefined;
          return [key(r), { round, quote }] as const;
        })
      );
      if (active) setViews(Object.fromEntries(pairs));
    };
    run();
    const timer = window.setInterval(run, 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [wallet, records]);

  // Auto-record settled losses on the leaderboard (no wallet signature needed).
  useEffect(() => {
    if (!wallet) return;
    for (const rec of records) {
      if (rec.done) continue;
      const view = views[key(rec)];
      const round = view?.round;
      if (!round || round.phase !== "EXPIRED" || !round.winner) continue;
      if (round.winner === rec.side) continue; // a win — user redeems it
      const id = key(rec);
      if (reportedLoss.current.has(id)) continue;
      reportedLoss.current.add(id);
      fetch("/api/result", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ wallet, marketId: rec.marketId, side: rec.side, stake: rec.stake, won: false, payout: 0 }),
      })
        .then(() => {
          patchBet(wallet, rec.marketId, rec.side, { done: true, won: false });
          refresh();
        })
        .catch(() => reportedLoss.current.delete(id));
    }
  }, [wallet, records, views, refresh]);

  const act = async (rec: BetRecord, fn: () => Promise<{ error?: string }>, label: string) => {
    setBusy(key(rec));
    setNote("");
    try {
      await fn();
      setNote(`${label} complete.`);
      refresh();
    } catch (error) {
      setNote(error instanceof Error ? error.message : `${label} failed.`);
    } finally {
      setBusy(null);
    }
  };

  if (!wallet) {
    // Mid-reconnect (e.g. right after a refresh): don't tell an already-linked
    // visitor to connect — show that we're restoring their session instead.
    if (reconnecting) {
      return (
        <div className="state-panel">
          <div className="state-spinner">
            <span className="logo-mark">
              <span />
            </span>
          </div>
          <h2>Reconnecting your wallet</h2>
          <p>One moment while we restore your session.</p>
        </div>
      );
    }
    return (
      <div className="state-panel">
        <div className="state-icon">◇</div>
        <h2>Connect to see your positions</h2>
        <p>Your open calls, live cash-out value, and settled wins show up here once your wallet is connected.</p>
        <button className="up-action" onClick={onConnect}>
          Connect wallet
        </button>
      </div>
    );
  }

  const open = records.filter((r) => !r.done);
  const history = records.filter((r) => r.done);

  if (records.length === 0) {
    return (
      <div className="state-panel">
        <div className="state-icon">+</div>
        <h2>No positions yet</h2>
        <p>Your open calls and settled wins will appear here.</p>
        <a className="up-action app-action-link" href="/app">
          Explore markets
        </a>
      </div>
    );
  }

  const row = (rec: BetRecord) => {
    const view = views[key(rec)];
    const round = view?.round;
    const quote = view?.quote;
    const settled = round?.phase === "EXPIRED";
    const won = settled && round?.winner === rec.side;
    const lost = settled && round?.winner != null && round.winner !== rec.side;
    const isBusy = busy === key(rec);
    // Prefer the freshly-fetched round's expiry, but fall back to the one we saved
    // at bet time so the countdown shows immediately — even if the per-market round
    // read is slow or the market has aged out of the discovery window.
    const expiry = round?.expiry ?? rec.expiry ?? null;
    const secs = expiry != null ? expiry - now / 1000 : 0;

    // A history record is terminal even when its market has aged out of the
    // rounds endpoint. Never let the countdown fallback overwrite Won/Lost.
    let statusLabel = rec.done ? (rec.won === true ? "Won" : "Lost") : "Open";
    if (!rec.done && won) statusLabel = "Won";
    else if (!rec.done && lost) statusLabel = "Lost";
    else if (!rec.done && settled) statusLabel = "Settled";
    else if (!rec.done && expiry != null && secs <= 0) statusLabel = "Locked";

    return (
      <div className="position-row" key={key(rec)}>
        <div className="position-head">
          <b>{rec.asset} / USD</b>
          <span className={`position-side ${rec.side === "UP" ? "up" : "down"}`}>{rec.side}</span>
          <span className={`position-status${won ? " won" : lost ? " lost" : ""}`}>{statusLabel}</span>
        </div>
        <div className="position-stats">
          <div>
            <span>Stake</span>
            <strong>{rec.stake} tUSDC</strong>
          </div>
          <div>
            <span>Filled</span>
            <strong>{rec.filledQty ? `${rec.filledQty}` : "--"}</strong>
          </div>
          {!rec.done && <div>
            <span>{settled ? "Result" : "Time left"}</span>
            <strong>{settled ? statusLabel : expiry != null ? (secs > 0 ? formatTime(secs) : "Locked") : "…"}</strong>
          </div>}
          <div>
            <span>Potential payout</span>
            <strong>{rec.filledQty ? `${rec.filledQty.toFixed(2)} tUSDC` : "--"}</strong>
          </div>
        </div>
        <div className="position-actions">
          {!settled && !rec.done && (
            <button
              className="up-action"
              disabled={isBusy || secs <= 0 || !quote?.canCashOut}
              title={
                quote?.canCashOut
                  ? "Sell your position back to the order book now"
                  : "No buyers on the book yet — cash out isn't available for this position right now."
              }
              onClick={() => act(rec, () => onCashOut(rec), "Cash out")}
            >
              {isBusy ? "Confirming…" : quote?.canCashOut ? `Cash out ${(quote.estProceeds ?? 0).toFixed(2)} tUSDC` : "Cash out unavailable"}
            </button>
          )}
          {won && !rec.done && (
            <button className="lime-btn" disabled={isBusy} onClick={() => act(rec, () => onRedeem(rec, true), "Redeem")}>
              {isBusy ? "Confirming…" : "Redeem winnings"}
            </button>
          )}
          {rec.done && rec.txHash && (
            <a className="text-link" href={`https://shannon-explorer.somnia.network/tx/${rec.txHash}`} target="_blank" rel="noreferrer">
              View tx ↗
            </a>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="positions-wrap">
      <div className="positions-page-head"><div><div className="eyebrow">Portfolio</div><h2>Your positions</h2></div><div className="positions-summary"><span>{open.length} open</span><span>{history.length} settled</span></div></div>
      {note && <p className="position-note">{note}</p>}
      <div className="positions-section">
        <div className="eyebrow">Open calls</div>
        {open.length ? open.map(row) : <p className="position-empty">No open calls right now.</p>}
      </div>
      {history.length > 0 && (
        <div className="positions-section">
          <div className="eyebrow">History</div>
          {history.map(row)}
        </div>
      )}
    </div>
  );
}

// ── Leaderboard ────────────────────────────────────────────────────────────────
function LeaderboardPanel({
  leaders,
  me,
  metric,
  setMetric,
  myWallet,
}: {
  leaders: LeaderboardEntry[];
  me: LeaderboardEntry | null;
  metric: Metric;
  setMetric: (m: Metric) => void;
  myWallet: string;
}) {
  const winRate = (e: LeaderboardEntry) => {
    const total = e.wins + e.losses;
    return total ? e.wins / total : 0;
  };
  const sorted = useMemo(() => {
    const arr = [...leaders];
    if (metric === "pnl") arr.sort((a, b) => b.pnl - a.pnl);
    else if (metric === "winrate") arr.sort((a, b) => winRate(b) - winRate(a));
    else arr.sort((a, b) => b.bestStreak - a.bestStreak || b.wins - a.wins);
    return arr;
  }, [leaders, metric]);

  const metricValue = (e: LeaderboardEntry) => {
    if (metric === "pnl") return `${e.pnl >= 0 ? "+" : ""}${e.pnl}`;
    if (metric === "winrate") return `${Math.round(winRate(e) * 100)}%`;
    return `${e.bestStreak} streak`;
  };

  return (
    <div className="market-panel leaderboard-panel">
      <div className="eyebrow">Top guessers</div>
      <h2>Leaderboard</h2>

      <div className="leaderboard-toggle" role="tablist">
        {(["streak", "winrate", "pnl"] as Metric[]).map((m) => (
          <button key={m} role="tab" aria-selected={metric === m} className={metric === m ? "selected" : ""} onClick={() => setMetric(m)}>
            {m === "streak" ? "Best streak" : m === "winrate" ? "Win rate" : "PnL"}
          </button>
        ))}
      </div>

      {sorted.length ? (
        sorted.map((entry, index) => {
          const isMe = myWallet && entry.wallet.toLowerCase() === myWallet.toLowerCase();
          return (
            <div className={`leader-row${isMe ? " me" : ""}`} key={entry.wallet}>
              <b>#{index + 1}</b>
              <span>
                {entry.handle || short(entry.wallet)}
                {isMe ? " (you)" : ""}
              </span>
              <small>
                {entry.wins} wins · {entry.losses} losses
              </small>
              <strong>{metricValue(entry)}</strong>
            </div>
          );
        })
      ) : (
        <div className="state-inline">
          <div className="state-icon">↑</div>
          <p>No settled calls yet. Your record will appear after your first resolved round.</p>
          <a href="/app">Find a market</a>
        </div>
      )}

      {me && !sorted.some((e) => e.wallet.toLowerCase() === me.wallet.toLowerCase()) && (
        <div className="leader-row me" key="me-standing">
          <b>#{me.rank}</b>
          <span>{me.handle || short(me.wallet)} (you)</span>
          <small>
            {me.wins} wins · {me.losses} losses
          </small>
          <strong>{metricValue(me)}</strong>
        </div>
      )}
    </div>
  );
}





