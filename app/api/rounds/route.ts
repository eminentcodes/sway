// GET /api/rounds → Round[] (current feed: NEXT, LIVE, EXPIRED)
// The home screen's primary data source. Read-only, no funds needed.
import { NextResponse } from "next/server";
import { getRounds } from "../../../lib/somnia/rounds";

export const dynamic = "force-dynamic"; // live chain data, never cache

let cachedRounds: Awaited<ReturnType<typeof getRounds>> = [];
let cachedAt = 0;
let refresh: Promise<typeof cachedRounds> | null = null;
const FRESH_FOR_MS = 5_000;
const RPC_TIMEOUT_MS = 6_000;

async function refreshRounds() {
  if (!refresh) {
    refresh = Promise.race([
      getRounds(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Market feed timed out")), RPC_TIMEOUT_MS)),
    ]).then((rounds) => {
      cachedRounds = rounds;
      cachedAt = Date.now();
      return rounds;
    }).finally(() => { refresh = null; });
  }
  return refresh;
}

// Warm the cache the moment this route module loads, so the first browser hit
// piggybacks on an already-in-flight read (deduped by `refresh`) instead of
// paying the full cold RPC latency. Best-effort: if it fails, the first GET just
// does the work itself.
void refreshRounds().catch(() => undefined);

export async function GET() {
  try {
    if (cachedRounds.length && Date.now() - cachedAt < FRESH_FOR_MS) {
      return NextResponse.json({ rounds: cachedRounds, cached: true });
    }
    if (cachedRounds.length) {
      void refreshRounds().catch(() => undefined);
      return NextResponse.json({ rounds: cachedRounds, cached: true, refreshing: true });
    }
    const rounds = await refreshRounds();
    return NextResponse.json({ rounds, cached: false });
  } catch (e: any) {
    return NextResponse.json(
      { rounds: [], error: e?.message || "Failed to load rounds" },
      { status: 502 }
    );
  }
}
