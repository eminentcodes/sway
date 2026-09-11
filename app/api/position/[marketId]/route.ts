// GET /api/position/:marketId?pool=0x…&side=UP|DOWN[&account=0x…]
//   → { quote: CashOutQuote }   (see lib/types.ts)
//
// A live cash-out quote for an open position: what selling now would return,
// walking the resting bids on the held side. Read-only — balance + order-book,
// no signing — so it's safe to hit freely and to quote any address.
//
// ⚠️ WALLET MODEL: with no ?account, this reads the SERVER wallet's position
// (the Path-B / demo wallet that /api/bet signs with). Pass ?account=0x… to
// quote a specific address server-side. The browser's real path (Path A) can
// call positionValue(args, bindWallet(walletClient)) directly, but routing the
// visitor's address through here sidesteps the browser-CORS risk on the indexer
// read (AGENT.md §3). Either way it's a pure read; no key is ever exposed.
import { NextRequest, NextResponse } from "next/server";
import { positionValue } from "../../../../lib/somnia/trade";
import { Side } from "../../../../lib/types";

export const dynamic = "force-dynamic";

function isSide(s: any): s is Side {
  return s === "UP" || s === "DOWN";
}

export async function GET(req: NextRequest, { params }: { params: { marketId: string } }) {
  const { searchParams } = new URL(req.url);
  const pool = searchParams.get("pool");
  const side = searchParams.get("side");
  const account = searchParams.get("account") || undefined;

  if (!pool || !/^0x[0-9a-fA-F]{40}$/.test(pool) || !isSide(side)) {
    return NextResponse.json({ error: "Pass ?pool=0x…&side=UP|DOWN" }, { status: 400 });
  }
  if (account && !/^0x[0-9a-fA-F]{40}$/.test(account)) {
    return NextResponse.json({ error: "Bad account address" }, { status: 400 });
  }

  // positionValue swallows its own read errors and returns a zeroed quote
  // (canCashOut:false), so this is always a clean 200 with a usable shape.
  const quote = await positionValue({ marketId: params.marketId, pool, side, account });
  return NextResponse.json({ quote });
}
