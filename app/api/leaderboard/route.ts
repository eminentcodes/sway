// GET /api/leaderboard → LeaderboardEntry[] (ranked)
// GET /api/leaderboard?wallet=0x… also includes the caller's own standing.
import { NextRequest, NextResponse } from "next/server";
import { getLeaderboard, getPlayer } from "../../../lib/db";

export const dynamic = "force-dynamic"; // always fresh; it's a live board

export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get("wallet");
  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit")) || 50, 200);
  const entries = getLeaderboard(limit);
  const me = wallet ? getPlayer(wallet) : null;
  return NextResponse.json({ entries, me });
}
