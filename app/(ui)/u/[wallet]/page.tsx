"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

interface ShareProfile {
  wallet: string;
  handle?: string;
  headline: string;
  wins: number;
  losses: number;
  winRate: number;
  streak: number;
  bestStreak: number;
  pnl: number;
  rank: number;
  tagline: string;
}

export default function PublicProfile() {
  const params = useParams<{ wallet: string }>();
  const [profile, setProfile] = useState<ShareProfile | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    fetch(`/api/share/${params.wallet}`)
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Profile unavailable");
        return body;
      })
      .then((body) => { if (alive) setProfile(body); })
      .catch((reason: Error) => { if (alive) setError(reason.message); });
    return () => { alive = false; };
  }, [params.wallet]);

  return <main className="profile-page">
    <nav className="nav"><a className="brand" href="/">sway.</a><a className="lime-btn profile-link" href="/#app">Play Sway</a></nav>
    <section className="profile-stage">
      <div className="profile-glow" />
      <div className="share-card">
        <div className="eyebrow">Public player profile</div>
        {profile ? <>
          <p className="profile-handle">{profile.handle || `${profile.wallet.slice(0, 8)}…${profile.wallet.slice(-5)}`}</p>
          <h1>{profile.headline}</h1>
          <p>{profile.tagline}</p>
          <div className="share-stats">
            <div><strong>{profile.winRate}%</strong><span>Win rate</span></div>
            <div><strong>{profile.bestStreak}</strong><span>Best streak</span></div>
            <div><strong>#{profile.rank}</strong><span>Rank</span></div>
          </div>
        </> : <>
          <p className="profile-handle">Sway player</p>
          <h1>{error || "Loading the receipts"}</h1>
          <p>{error ? "This wallet has no settled calls yet." : "Pulling the latest stats from the leaderboard."}</p>
        </>}
        <a className="dark-btn profile-link" href="/#app">Make your call</a>
      </div>
    </section>
  </main>;
}
