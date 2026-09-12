// GET /api/share/:wallet → the payload for a shareable result card (feature S3).
// Returns the player's headline stats so the UI (or an OG image) can render
// "I went 12-3 · 5🔥 · +42 USDC on Sway". Read-only.
import { NextRequest, NextResponse } from "next/server";
import { getPlayer } from "../../../../lib/db";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: { wallet: string } }) {
  const p = await getPlayer(params.wallet);
  if (!p) {
    return NextResponse.json({ error: "No results yet for this wallet" }, { status: 404 });
  }
  const total = p.wins + p.losses;
  const winRate = total ? Math.round((p.wins / total) * 100) : 0;
  return NextResponse.json({
    wallet: p.wallet,
    handle: p.handle,
    headline: `${p.wins}-${p.losses} · ${p.bestStreak}🔥 · ${p.pnl >= 0 ? "+" : ""}${p.pnl} USDC`,
    wins: p.wins,
    losses: p.losses,
    winRate,
    streak: p.streak,
    bestStreak: p.bestStreak,
    pnl: p.pnl,
    rank: p.rank,
    tagline: "Tap the crowd on Sway",
  });
}
