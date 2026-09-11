// POST /api/bet → place a bet on a round. Body: { marketId, pool, side, amountUsd }.
// Returns a BetResult (see lib/types.ts).
//
// ⚠️ WALLET MODEL (decision D2): this route signs with the SERVER dev key
// (sharedExchange), i.e. ONE shared wallet, not the visitor's own. That is the
// documented fallback so the frontend can build the full tap → confirm → result
// loop today. The authentic per-user path — passing the browser's wagmi
// WalletClient into placeBet — is the open task in AGENT.md §8. When that lands,
// the client will sign locally and this route becomes demo-only.
//
// Because it spends a shared server-funded wallet, keep it server-side only and
// do NOT expose the key to the client. No auth here (hackathon scope) — noted so
// it's a deliberate choice, not an oversight.
import { NextRequest, NextResponse } from "next/server";
import { placeBet } from "../../../lib/somnia/trade";
import { BetResult, Side } from "../../../lib/types";

export const dynamic = "force-dynamic";

function isSide(s: any): s is Side {
  return s === "UP" || s === "DOWN";
}

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  // Validate — never trust the client. marketId + pool + side + positive amount.
  if (
    typeof body?.marketId !== "string" ||
    typeof body?.pool !== "string" ||
    !/^0x[0-9a-fA-F]{40}$/.test(body.pool) ||
    !isSide(body?.side) ||
    typeof body?.amountUsd !== "number" ||
    !(body.amountUsd > 0)
  ) {
    return NextResponse.json({ ok: false, error: "Malformed bet request" }, { status: 400 });
  }

  // placeBet already gates on live tradability and maps reverts to friendly text,
  // so a failed bet comes back as ok:false (200), not a thrown 500.
  const result: BetResult = await placeBet({
    marketId: body.marketId,
    pool: body.pool,
    side: body.side,
    amountUsd: body.amountUsd,
  });

  return NextResponse.json(result);
}
