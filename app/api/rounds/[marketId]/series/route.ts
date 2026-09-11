// GET /api/rounds/:marketId/series?interval=60
//   → { series: ProbabilityPoint[], interval: number }   (see lib/types.ts)
//
// "Sway the line" — the round's implied-probability history as OHLC points, so
// the UI can chart the crowd's belief moving across the round. The order-book
// price of UP (YES) IS a money-weighted probability, so this is the OHLC of that
// belief. Read-only; an empty series (no fills yet) is a valid 200, not an error.
//
// `interval` is the candle BUCKET size in seconds (60 / 300 / 900 / 3600 /
// 14400 / 86400 — the buckets the indexer materializes), NOT the round window
// length. We snap anything else to 60 so the echoed `interval` is always the
// bucket actually used.
import { NextRequest, NextResponse } from "next/server";
import { CANDLE_INTERVALS } from "@somnia-chain/markets-sdk";
import { getProbabilitySeries } from "../../../../../lib/somnia/rounds";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: { marketId: string } }) {
  const { searchParams } = new URL(req.url);
  const raw = Number(searchParams.get("interval"));
  const interval = (CANDLE_INTERVALS as readonly number[]).includes(raw) ? raw : 60;

  try {
    const series = await getProbabilitySeries(params.marketId, interval);
    return NextResponse.json({ series, interval });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Failed to load series" }, { status: 500 });
  }
}
