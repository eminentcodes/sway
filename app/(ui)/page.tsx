"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAccount, useConnect } from "wagmi";
import { ArrowRight, Loader2, Wallet, X } from "lucide-react";
import type { LeaderboardEntry, Round } from "../../lib/types";

function formatTime(seconds: number) {
  const value = Math.max(0, seconds);
  return `${Math.floor(value / 60).toString().padStart(2, "0")}:${(value % 60).toString().padStart(2, "0")}`;
}

export default function Home() {
  const { isConnected } = useAccount();
  const [walletOpen, setWalletOpen] = useState(false);
  const [walletError, setWalletError] = useState("");
  const [round, setRound] = useState<Round | null>(null);
  const [leaders, setLeaders] = useState<LeaderboardEntry[]>([]);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const [roundResponse, leaderResponse] = await Promise.all([fetch("/api/rounds"), fetch("/api/leaderboard")]);
        const rounds = await roundResponse.json();
        const leaderboard = await leaderResponse.json();
        if (active) { setRound(rounds.rounds?.[0] || null); setLeaders(leaderboard.entries?.slice(0, 3) || []); }
      } catch { /* the hero remains useful while live data is unavailable */ }
    };
    load();
    const refresh = window.setInterval(load, 8000);
    const clock = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => { active = false; window.clearInterval(refresh); window.clearInterval(clock); };
  }, []);

  const up = round?.upProbability == null ? 50 : Math.round(round.upProbability * 100);
  const remaining = round ? round.expiry - now : 0;

  return <main className="site-shell">
    <nav className="nav"><a className="brand" href="#top"><LogoMark /><span>sway</span></a><div className="nav-links"><a href="#how">How it works</a><a href="#edge">Why Sway</a><a href="#pulse">Social pulse</a><a href="#faq">FAQ</a></div><div className="nav-actions">{isConnected ? <Link className="lime-btn nav-link-btn" href="/app">Open app</Link> : <button type="button" className="lime-btn" onClick={() => { setWalletError(""); setWalletOpen(true); }}>Connect wallet</button>}</div></nav>
    <section id="top" className="hero"><div className="hero-copy"><h1>Call the next move.<br /><span>Lock your odds.</span></h1><p>Choose BTC or ETH, tap UP or DOWN, and know your potential payout before the round closes.</p><div className="hero-actions"><Link className="lime-btn nav-link-btn hero-cta" href="/app">Choose a market</Link><a className="text-link" href="#how">See how it works <span>↗</span></a></div></div><div className="phone-stage"><div className="phone-glow" /><div className="phone"><div className="phone-notch" /><div className="phone-top"><span>9:41</span><span>◌ 5G</span></div><div className="phone-brand"><LogoMark /><span>sway</span></div><div className="phone-label">LIVE ROUND</div><h3>{round?.asset || "BTC"} / USD</h3><small>{round ? `${round.phase} · closes in ${formatTime(remaining)}` : "Finding a live round"}</small><div className="phone-chart"><span style={{ left: "9%", top: "63%" }} /><span style={{ left: "29%", top: "49%" }} /><span style={{ left: "52%", top: "57%" }} /><span style={{ left: "72%", top: "26%" }} /><span style={{ left: "90%", top: "35%" }} /></div><div className="phone-market"><span>Crowd leaning UP</span><b>{up}%</b></div><div className="phone-market"><span>UP payout</span><b>{round?.upPayout ? `${round.upPayout}x` : "--"}</b></div><div className="phone-market"><span>DOWN payout</span><b>{round?.downPayout ? `${round.downPayout}x` : "--"}</b></div><div className="phone-button">Choose a side <span>→</span></div></div></div></section>
    <section id="how" className="section"><div className="section-head"><div><div className="eyebrow">How it works</div><h2>Three taps<br />to a call.</h2></div><p className="section-copy">Sway is a directional game for people who want a clean opinion, not a trading cockpit.</p></div><div className="steps"><article className="step"><span className="step-num">01</span><h3>Pick a live round</h3><p>Choose BTC or ETH and see the crowd’s current probability.</p></article><article className="step"><span className="step-num">02</span><h3>Tap UP or DOWN</h3><p>Enter before the window locks. Your payout multiplier is visible immediately.</p></article><article className="step"><span className="step-num">03</span><h3>Collect if right</h3><p>The market resolves on Somnia. Winners redeem their collateral after expiry.</p></article></div></section>
    <section id="edge" className="section dark"><div className="edge-layout"><div><div className="eyebrow lime-label">Why Sway</div><h2>Your upside<br /><span>doesn’t dilute.</span></h2></div><div className="edge-copy"><p>Unlike a pool, your multiplier is set by the order book when you enter. Later players do not change your return.</p><div className="edge-facts"><span><b>sub-second</b><small>Somnia settlement</small></span><span><b>1 entry</b><small>payout locked at tap</small></span><span><b>no leverage</b><small>no liquidations</small></span></div></div></div></section>
    <section id="pulse" className="section pulse-section"><div className="section-head"><div><div className="eyebrow">Social pulse</div><h2>Feel the room<br />before you play.</h2></div><p className="section-copy">Every round has a mood. Every win has a record worth sharing.</p></div><div className="pulse-grid"><div className="pulse-round"><div className="pulse-top"><span>{round?.asset || "BTC"} / USD</span><b>{up}% UP</b></div><div className="pulse-bar"><span style={{ width: `${up}%` }} /></div><div className="pulse-bottom"><span>crowd meter</span><span>{round ? `${formatTime(remaining)} left` : "live data loading"}</span></div></div><div className="leader-preview"><div className="preview-title">Top guessers <span>View leaderboard ↗</span></div>{leaders.length ? leaders.map((entry) => <div className="preview-row" key={entry.wallet}><b>0{entry.rank}</b><span>{entry.handle || `${entry.wallet.slice(0, 6)}…${entry.wallet.slice(-4)}`}</span><strong>{entry.wins} wins</strong></div>) : <div className="preview-empty">The first settled calls will appear here.</div>}</div></div></section>
    <section className="share-strip"><div><div className="eyebrow">Share the read</div><h2>Make a good call<br />a public flex.</h2></div><p>Share your streak, your record, and the round that made you right.</p><Link className="dark-btn nav-link-btn" href="/app">Play Sway <span>↗</span></Link></section>
    <section className="trust-strip"><strong>Built on Somnia</strong><span>Real Event Contract orders via DreamDEX</span><span>Shannon testnet · tUSDC only</span></section>
    <section className="section after-tap"><div className="section-head"><div><div className="eyebrow">After your call</div><h2>From tap<br />to result.</h2></div><p className="section-copy">Every call follows a visible round lifecycle, so you always know what happens next.</p></div><div className="steps"><article className="step"><h3>Your odds lock</h3><p>The filled order sets your payout multiplier. Later entries do not change it.</p></article><article className="step"><h3>The round resolves</h3><p>The scheduled BTC or ETH market closes and settles from its event-contract outcome.</p></article><article className="step"><h3>Winners redeem</h3><p>Winning outcome tokens redeem for test collateral, and your result updates your record.</p></article></div></section><section id="faq" className="section faq-section"><div className="section-head"><div><div className="eyebrow">Good to know</div><h2>Questions,<br />answered.</h2></div></div><div className="faq"><div className="faq-item"><h3>What am I predicting?</h3><p>You are choosing whether BTC or ETH will finish the active round higher or lower.</p></div><div className="faq-item"><h3>When are my odds locked?</h3><p>Your payout multiplier is fixed when your order fills, before the market closes.</p></div><div className="faq-item"><h3>Can I see the crowd before choosing?</h3><p>Yes. Each market shows the live UP probability and payout available for both sides.</p></div><div className="faq-item"><h3>What happens when the timer ends?</h3><p>The round locks, resolves on Somnia, and winning positions become redeemable.</p></div><div className="faq-item"><h3>What do I need to start?</h3><p>An EVM wallet connected to the Shannon testnet with test STT and tUSDC.</p></div><div className="faq-item"><h3>Does Sway control my wallet?</h3><p>No. You approve each transaction yourself and Sway never receives your private key.</p></div></div></section>
    <footer className="footer"><a className="brand" href="#top"><LogoMark /><span>sway</span></a><span>Built on Somnia · DreamDEX · Shannon testnet</span><Link href="/app">Launch app ↗</Link></footer>
    {walletOpen && <WalletModal error={walletError} onClose={() => setWalletOpen(false)} onError={setWalletError} />}
  </main>;
}

/** Turn a wagmi/viem/EIP-1193 connect failure into an honest message — not a blanket "cancelled". */
function walletErrorMessage(e: unknown): string {
  const err = e as { name?: string; code?: number; shortMessage?: string; message?: string; cause?: { code?: number; name?: string } };
  const code = err?.code ?? err?.cause?.code;
  const name = err?.name ?? err?.cause?.name;
  // Genuine rejection in the wallet popup (EIP-1193 4001).
  if (code === 4001 || name === "UserRejectedRequestError") return "You dismissed the request in your wallet. Tap connect when you're ready.";
  // MetaMask already has a prompt open (double-click / earlier request left hanging).
  if (code === -32002) return "Your wallet already has a request open — approve or dismiss it there, then try again.";
  return err?.shortMessage || err?.message || "Couldn't reach your wallet. Make sure it's unlocked, then try again.";
}

function WalletModal({ error, onClose, onError }: { error: string; onClose: () => void; onError: (message: string) => void }) {
  const { isConnected } = useAccount();
  const { connectAsync, connectors, isPending } = useConnect();
  const router = useRouter();
  const connect = async (connector: (typeof connectors)[number]) => {
    try { await connectAsync({ connector }); router.push("/app"); }
    catch (e) { if ((e as { name?: string }).name === "ConnectorAlreadyConnectedError") router.push("/app"); else onError(walletErrorMessage(e)); }
  };
  const available = connectors.filter((connector, index, list) => list.findIndex((item) => item.uid === connector.uid) === index);
  return <div className="wallet-overlay" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}><section className="wallet-modal landing-wallet-modal" role="dialog" aria-modal="true" aria-labelledby="wallet-title"><button className="wallet-close" onClick={onClose} aria-label="Close wallet dialog"><X size={18} /></button><div className="wallet-heading"><span className="wallet-heading-icon"><span className="logo-mark"><span /></span></span><div><div className="eyebrow">Sway</div><h2 id="wallet-title">Connect wallet</h2></div></div><p className="wallet-subtitle">Choose a wallet to continue.</p>{isConnected ? <button className="wallet-option" onClick={() => { router.push("/app"); }}><span className="wallet-icon"><Wallet size={20} /></span><span><b>Continue to Sway</b><small>Your wallet is already connected</small></span><strong><ArrowRight size={18} /></strong></button> : available.length ? available.map((connector) => <button className="wallet-option" key={connector.uid} onClick={() => connect(connector)} disabled={isPending}><span className="wallet-icon"><Wallet size={20} /></span><span><b>{connector.name}</b><small>Connect securely</small></span><strong>{isPending ? <Loader2 className="spin-icon" size={18} /> : <ArrowRight size={18} />}</strong></button>) : <p className="wallet-error">No compatible browser wallet found.</p>}<div className="wallet-network"><span className="network-dot" /> Somnia Shannon testnet</div>{error && <p className="wallet-error" role="alert">{error}</p>}</section></div>;
}
function LogoMark() { return <span className="logo-mark" aria-hidden="true"><span /></span>; }



