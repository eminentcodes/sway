// POST /api/cashout → sell an open position back to the book (cash out early).
// Body: { marketId, pool, side }. Returns a CashOutResult (see lib/types.ts).
//
// ⚠️ WALLET MODEL — mirrors /api/bet exactly. This signs with the SERVER dev key
// (sharedExchange), so it can only cash out the SERVER wallet's own position —
// i.e. positions opened through /api/bet (Path B). The authentic per-user path
// is client-side: sellPosition(args, bindWallet(walletClient)), which sells the
// VISITOR's own tokens. You cash out on whichever wallet you bet with. Keep this
// route server-side only; the key is never exposed to the client.
//
// No amount in the body on purpose: a cash-out always sells the FULL held
// balance on that side (a clean, tap-and-go exit). No market fee on exits — the
// cut is on entry only.
import { NextRequest, NextResponse } from "next/server";
import { sellPosition } from "../../../lib/somnia/trade";
import { CashOutResult, Side } from "../../../lib/types";

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

  // Validate — never trust the client. marketId + pool + side (no amount).
  if (
    typeof body?.marketId !== "string" ||
    typeof body?.pool !== "string" ||
    !/^0x[0-9a-fA-F]{40}$/.test(body.pool) ||
    !isSide(body?.side)
  ) {
    return NextResponse.json({ ok: false, error: "Malformed cash-out request" }, { status: 400 });
  }

  // sellPosition maps reverts to friendly text and returns ok:false on an empty
  // book / no position, so a failed exit comes back as ok:false (200), not a 500.
  const result: CashOutResult = await sellPosition({
    marketId: body.marketId,
    pool: body.pool,
    side: body.side,
  });

  return NextResponse.json(result);
}
